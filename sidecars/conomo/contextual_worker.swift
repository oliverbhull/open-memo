import Accelerate
import CoreML
import Foundation

private let sampleRate = 16_000
private let maxSamples = 163_840
private let featureFrames = 512
private let melFrames = 1_024
private let fftSize = 512
private let hopLength = 160
private let windowLength = 400
private let melBins = 80

private func logError(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
private let contextualBeamWidth = 8
private let contextualTopTokens = 16
private let contextualTokenFloor: Float = 20
private let contextualTermBoost: Float = 20

private func logAdd(_ left: Float, _ right: Float) -> Float {
  if left == -.infinity { return right }
  if right == -.infinity { return left }
  let high = max(left, right), low = min(left, right)
  return high + log1p(exp(low - high))
}

private struct BeamScores {
  var blank = -Float.infinity
  var nonBlank = -Float.infinity
  var total: Float { logAdd(blank, nonBlank) }
}

private func contextualBonus(_ prefix: [Int], patterns: [[Int]], wordStarts: Set<Int>) -> Float {
  var bonus: Float = 0
  for pattern in patterns where !pattern.isEmpty {
    var matched = false
    if pattern.count <= prefix.count {
      for start in 0...(prefix.count - pattern.count) {
        let end = start + pattern.count
        if pattern.indices.allSatisfy({ prefix[start + $0] == pattern[$0] })
            && (end == prefix.count || wordStarts.contains(prefix[end])) {
          matched = true
          break
        }
      }
    }
    if matched {
      bonus += contextualTermBoost
      continue
    }

    // Keep an acoustically plausible vocabulary spelling alive while it is
    // being assembled. Without this prefix reward, `rayaan` loses to `rayon`
    // after the shared `ray` token before the complete-term boost can apply.
    let maximumPrefix = min(prefix.count, pattern.count - 1)
    if maximumPrefix > 0 {
      for length in stride(from: maximumPrefix, through: 1, by: -1) {
        let start = prefix.count - length
        if (0..<length).allSatisfy({ prefix[start + $0] == pattern[$0] }) {
          bonus += contextualTermBoost * Float(length) / Float(pattern.count)
          break
        }
      }
    }
  }
  return bonus
}

private func contextualDecode(
  steps: Int,
  vocab: Int,
  patterns: [[Int]],
  wordStarts: Set<Int>,
  valueAt: (Int, Int) -> Float
) -> [Int] {
  guard !patterns.isEmpty else { return [] }
  let patternTokens = Set(patterns.flatMap { $0 })
  var beams: [[Int]: BeamScores] = [[]: BeamScores(blank: 0, nonBlank: -.infinity)]
  var bonusCache: [[Int]: Float] = [:]

  for step in 0..<steps {
    var top: [(Int, Float)] = []
    var maximum = -Float.infinity
    for token in 0..<vocab {
      let value = valueAt(step, token)
      maximum = max(maximum, value)
      if top.count < contextualTopTokens || value > top.last!.1 {
        top.append((token, value))
        top.sort { $0.1 > $1.1 }
        if top.count > contextualTopTokens { top.removeLast() }
      }
    }
    var candidates = Dictionary(uniqueKeysWithValues: top)
    candidates[0] = valueAt(step, 0)
    for token in patternTokens {
      let value = valueAt(step, token)
      if value >= maximum - contextualTokenFloor { candidates[token] = value }
    }

    var next: [[Int]: BeamScores] = [:]
    for (prefix, scores) in beams {
      let blankValue = candidates[0]!
      var unchanged = next[prefix] ?? BeamScores()
      unchanged.blank = logAdd(unchanged.blank, scores.total + blankValue)
      next[prefix] = unchanged

      for (token, value) in candidates where token != 0 {
        if prefix.last == token {
          var repeated = next[prefix] ?? BeamScores()
          repeated.nonBlank = logAdd(repeated.nonBlank, scores.nonBlank + value)
          next[prefix] = repeated

          let extended = prefix + [token]
          var extendedScores = next[extended] ?? BeamScores()
          extendedScores.nonBlank = logAdd(
            extendedScores.nonBlank,
            scores.blank + value
          )
          next[extended] = extendedScores
        } else {
          let extended = prefix + [token]
          var extendedScores = next[extended] ?? BeamScores()
          extendedScores.nonBlank = logAdd(
            extendedScores.nonBlank,
            scores.total + value
          )
          next[extended] = extendedScores
        }
      }
    }
    let ranked = next.map { item -> (key: [Int], value: BeamScores, score: Float) in
      let bonus = bonusCache[item.key] ?? contextualBonus(item.key, patterns: patterns, wordStarts: wordStarts)
      bonusCache[item.key] = bonus
      return (item.key, item.value, item.value.total + bonus)
    }.sorted { $0.score > $1.score }
    beams.removeAll(keepingCapacity: true)
    for item in ranked.prefix(contextualBeamWidth) {
      beams[item.key] = item.value
    }
  }
  return beams.max {
    $0.value.total + contextualBonus($0.key, patterns: patterns, wordStarts: wordStarts)
      < $1.value.total + contextualBonus($1.key, patterns: patterns, wordStarts: wordStarts)
  }?.key ?? []
}

private final class GraniteTokenizer {
  private let tokens: [String]
  private let unicodeToByte: [Unicode.Scalar: UInt8]

  init(url: URL) throws {
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let model = root["model"] as! [String: Any]
    let vocab = model["vocab"] as! [String: Int]
    var values = Array(repeating: "", count: (vocab.values.max() ?? 0) + 1)
    for (token, id) in vocab { values[id] = token }
    tokens = values

    var byteToUnicode: [UInt8: Unicode.Scalar] = [:]
    var visible = Array(33...126) + Array(161...172) + Array(174...255)
    let used = Set(visible)
    var extra = 0
    for byte in 0...255 where !used.contains(byte) {
      visible.append(byte)
      byteToUnicode[UInt8(byte)] = Unicode.Scalar(256 + extra)!
      extra += 1
    }
    for byte in Array(33...126) + Array(161...172) + Array(174...255) {
      byteToUnicode[UInt8(byte)] = Unicode.Scalar(byte)!
    }
    unicodeToByte = Dictionary(uniqueKeysWithValues: byteToUnicode.map { ($0.value, $0.key) })
  }

  func decode(_ ids: [Int]) -> String {
    let encoded = ids.compactMap { $0 > 0 && $0 < tokens.count ? tokens[$0] : nil }.joined()
    let bytes = encoded.unicodeScalars.compactMap { unicodeToByte[$0] }
    return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var wordStartTokenIds: Set<Int> {
    Set(tokens.indices.filter { tokens[$0].hasPrefix("Ġ") })
  }
}

private final class AudioFeatures {
  private let dft = vDSP.DFT(count: fftSize, direction: .forward, transformType: .complexComplex, ofType: Float.self)!
  private let window = (0..<windowLength).map { 0.5 - 0.5 * cos(2 * .pi * Float($0) / Float(windowLength)) }
  private let filters: [[Float]]

  init() {
    func hzToMel(_ hz: Float) -> Float { 2595 * log10(1 + hz / 700) }
    func melToHz(_ mel: Float) -> Float { 700 * (pow(10, mel / 2595) - 1) }
    let low = hzToMel(0), high = hzToMel(8000)
    let points = (0..<(melBins + 2)).map { melToHz(low + (high - low) * Float($0) / Float(melBins + 1)) }
    let bins = points.map { min(fftSize / 2, Int(floor(Float(fftSize + 1) * $0 / Float(sampleRate)))) }
    filters = (0..<melBins).map { index in
      var filter = Array(repeating: Float(0), count: fftSize / 2 + 1)
      let left = bins[index], center = bins[index + 1], right = bins[index + 2]
      if center > left { for k in left..<center { filter[k] = Float(k - left) / Float(center - left) } }
      if right > center { for k in center..<right { filter[k] = Float(right - k) / Float(right - center) } }
      return filter
    }
  }

  func make(_ input: [Int16]) throws -> MLMultiArray {
    var audio = input.prefix(maxSamples).map { Float($0) / 32768 }
    if audio.count < maxSamples { audio += Array(repeating: 0, count: maxSamples - audio.count) }
    var centered = Array(repeating: Float(0), count: audio.count + fftSize)
    for i in 0..<audio.count { centered[i + fftSize / 2] = audio[i] }
    for i in 0..<(fftSize / 2) {
      centered[fftSize / 2 - 1 - i] = audio[min(audio.count - 1, i + 1)]
      centered[fftSize / 2 + audio.count + i] = audio[max(0, audio.count - 2 - i)]
    }

    var mel = Array(repeating: Array(repeating: Float(0), count: melFrames), count: melBins)
    var globalMax = -Float.infinity
    for frameIndex in 0..<melFrames {
      let start = frameIndex * hopLength
      var real = Array(repeating: Float(0), count: fftSize)
      for i in 0..<windowLength { real[i] = centered[start + i] * window[i] }
      var imaginary = Array(repeating: Float(0), count: fftSize)
      var outputReal = Array(repeating: Float(0), count: fftSize)
      var outputImaginary = Array(repeating: Float(0), count: fftSize)
      dft.transform(inputReal: real, inputImaginary: imaginary, outputReal: &outputReal, outputImaginary: &outputImaginary)
      var power = Array(repeating: Float(0), count: fftSize / 2 + 1)
      for k in 0...fftSize / 2 { power[k] = outputReal[k] * outputReal[k] + outputImaginary[k] * outputImaginary[k] }
      for bin in 0..<melBins {
        var sum: Float = 0
        vDSP_dotpr(power, 1, filters[bin], 1, &sum, vDSP_Length(power.count))
        let value = log10(max(sum, 1e-10))
        mel[bin][frameIndex] = value
        globalMax = max(globalMax, value)
      }
    }
    let floorValue = globalMax - 8
    for bin in 0..<melBins { for frame in 0..<melFrames { mel[bin][frame] = max(mel[bin][frame], floorValue) / 4 + 1 } }

    var delta = Array(repeating: Array(repeating: Float(0), count: melFrames), count: melBins)
    for bin in 0..<melBins { for frame in 0..<melFrames {
      delta[bin][frame] = (mel[bin][min(melFrames - 1, frame + 1)] - mel[bin][max(0, frame - 1)]) / 2
    }}
    let result = try MLMultiArray(shape: [1, NSNumber(value: featureFrames), 320], dataType: .float32)
    for frame in 0..<featureFrames { for stacked in 0..<2 { for bin in 0..<melBins {
      let source = frame * 2 + stacked
      result[[0, frame as NSNumber, (stacked * 160 + bin) as NSNumber]] = NSNumber(value: mel[bin][source])
      result[[0, frame as NSNumber, (stacked * 160 + 80 + bin) as NSNumber]] = NSNumber(value: delta[bin][source])
    }}}
    return result
  }
}

private final class GraniteRuntime {
  private let model: MLModel
  private let tokenizer: GraniteTokenizer
  private let features = AudioFeatures()
  private var vocabularyPatterns: [[Int]] = []

  init(modelURL: URL, tokenizerURL: URL) throws {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    model = try MLModel(contentsOf: modelURL, configuration: configuration)
    tokenizer = try GraniteTokenizer(url: tokenizerURL)
  }

  func warmup() throws {
    _ = try transcribeChunk([])
  }

  func setVocabularyPatterns(_ patterns: [[Int]]) {
    vocabularyPatterns = patterns.filter { !$0.isEmpty && $0.allSatisfy { $0 > 0 } }
    logError("CONTEXTUAL: patterns=\(vocabularyPatterns.count)")
  }

  func transcribeChunk(_ samples: [Int16]) throws -> (text: String, greedy: String) {
    let started = CFAbsoluteTimeGetCurrent()
    let array = try features.make(samples)
    let featured = CFAbsoluteTimeGetCurrent()
    let provider = try MLDictionaryFeatureProvider(dictionary: ["input_features": MLFeatureValue(multiArray: array)])
    let output = try model.prediction(from: provider)
    let predicted = CFAbsoluteTimeGetCurrent()
    guard let logits = output.featureValue(for: "logits")?.multiArrayValue else { throw NSError(domain: "MemoGranite", code: 2, userInfo: [NSLocalizedDescriptionKey: "Core ML output logits missing"]) }
    let steps = logits.shape[1].intValue, vocab = logits.shape[2].intValue
    var ids: [Int] = [], previous = -1
    if logits.dataType == .float32 {
      let values = logits.dataPointer.bindMemory(to: Float.self, capacity: logits.count)
      let stepStride = logits.strides[1].intValue
      let tokenStride = logits.strides[2].intValue
      for step in 0..<steps {
        var best = 0, bestValue = -Float.infinity
        let stepOffset = step * stepStride
        for token in 0..<vocab {
          let value = values[stepOffset + token * tokenStride]
          if value > bestValue { bestValue = value; best = token }
        }
        if best != previous && best != 0 { ids.append(best) }
        previous = best
      }
    } else if logits.dataType == .float16 {
      let values = logits.dataPointer.bindMemory(to: UInt16.self, capacity: logits.count)
      let stepStride = logits.strides[1].intValue
      let tokenStride = logits.strides[2].intValue
      for step in 0..<steps {
        var best = 0, bestValue = -Float.infinity
        let stepOffset = step * stepStride
        for token in 0..<vocab {
          let value = Float(Float16(bitPattern: values[stepOffset + token * tokenStride]))
          if value > bestValue { bestValue = value; best = token }
        }
        if best != previous && best != 0 { ids.append(best) }
        previous = best
      }
    } else {
      for step in 0..<steps {
        var best = 0, bestValue = -Float.infinity
        for token in 0..<vocab {
          let value = logits[[0, step as NSNumber, token as NSNumber]].floatValue
          if value > bestValue { bestValue = value; best = token }
        }
        if best != previous && best != 0 { ids.append(best) }
        previous = best
      }
    }
    let greedyText = tokenizer.decode(ids)
    var text = greedyText
    if !vocabularyPatterns.isEmpty {
      let valueAt: (Int, Int) -> Float
      if logits.dataType == .float32 {
        let values = logits.dataPointer.bindMemory(to: Float.self, capacity: logits.count)
        let stepStride = logits.strides[1].intValue, tokenStride = logits.strides[2].intValue
        valueAt = { values[$0 * stepStride + $1 * tokenStride] }
      } else if logits.dataType == .float16 {
        let values = logits.dataPointer.bindMemory(to: UInt16.self, capacity: logits.count)
        let stepStride = logits.strides[1].intValue, tokenStride = logits.strides[2].intValue
        valueAt = { Float(Float16(bitPattern: values[$0 * stepStride + $1 * tokenStride])) }
      } else {
        valueAt = { logits[[0, $0 as NSNumber, $1 as NSNumber]].floatValue }
      }
      let contextualIds = contextualDecode(
        steps: steps,
        vocab: vocab,
        patterns: vocabularyPatterns,
        wordStarts: tokenizer.wordStartTokenIds,
        valueAt: valueAt
      )
      let candidate = tokenizer.decode(contextualIds)
      if !candidate.isEmpty { text = candidate }
    }
    let decoded = CFAbsoluteTimeGetCurrent()
    logError(String(format: "TIMING:features_ms=%.1f prediction_ms=%.1f decode_ms=%.1f total_ms=%.1f changed=%@", (featured - started) * 1_000, (predicted - featured) * 1_000, (decoded - predicted) * 1_000, (decoded - started) * 1_000, text != greedyText ? "true" : "false"))
    return (text, greedyText)
  }
}

private struct Message: Decodable { let type: String; let pcm16le: String?; let patterns: [[Int]]? }
private var arguments = CommandLine.arguments
func value(after flag: String) -> String? { guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }; return arguments[i + 1] }
guard let modelPath = value(after: "--model-path"), let tokenizerPath = value(after: "--tokenizer-path"), arguments.contains("--worker") else {
  logError("usage: memo-granite-asr --model-path MODEL.mlmodelc --tokenizer-path tokenizer.json --worker")
  exit(2)
}
do {
  let runtime = try GraniteRuntime(modelURL: URL(fileURLWithPath: modelPath), tokenizerURL: URL(fileURLWithPath: tokenizerPath))
  try runtime.warmup()
  var samples: [Int16] = []
  var completedTexts: [String] = []
  var completedGreedyTexts: [String] = []
  print("READY"); fflush(stdout)
  while let line = readLine() {
    do {
      let message = try JSONDecoder().decode(Message.self, from: Data(line.utf8))
      switch message.type {
      case "start": samples.removeAll(keepingCapacity: true); completedTexts.removeAll(keepingCapacity: true); completedGreedyTexts.removeAll(keepingCapacity: true)
      case "abort": samples.removeAll(keepingCapacity: true); completedTexts.removeAll(keepingCapacity: true); completedGreedyTexts.removeAll(keepingCapacity: true)
      case "context": runtime.setVocabularyPatterns(message.patterns ?? [])
      case "audio":
        guard let encoded = message.pcm16le, let data = Data(base64Encoded: encoded), data.count % 2 == 0 else { throw NSError(domain: "MemoGranite", code: 3, userInfo: [NSLocalizedDescriptionKey: "invalid PCM16 audio"] ) }
        data.withUnsafeBytes { raw in for pair in stride(from: 0, to: data.count, by: 2) { samples.append(Int16(bitPattern: UInt16(raw[pair]) | UInt16(raw[pair + 1]) << 8)) } }
        while samples.count >= maxSamples {
          let result = try runtime.transcribeChunk(Array(samples.prefix(maxSamples)))
          if !result.text.isEmpty { completedTexts.append(result.text) }
          if !result.greedy.isEmpty { completedGreedyTexts.append(result.greedy) }
          samples.removeFirst(maxSamples)
        }
      case "end":
        if !samples.isEmpty || completedTexts.isEmpty {
          let result = try runtime.transcribeChunk(samples)
          if !result.text.isEmpty { completedTexts.append(result.text) }
          if !result.greedy.isEmpty { completedGreedyTexts.append(result.greedy) }
        }
        let payload: [String: String] = [
          "processedText": completedTexts.joined(separator: " "),
          "greedyText": completedGreedyTexts.joined(separator: " "),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        print("FINAL:" + String(data: data, encoding: .utf8)!); fflush(stdout)
        samples.removeAll(keepingCapacity: true); completedTexts.removeAll(keepingCapacity: true); completedGreedyTexts.removeAll(keepingCapacity: true)
      default: throw NSError(domain: "MemoGranite", code: 4, userInfo: [NSLocalizedDescriptionKey: "unknown event \(message.type)"])
      }
    } catch { samples.removeAll(keepingCapacity: true); completedTexts.removeAll(keepingCapacity: true); print("ERROR:\(error.localizedDescription)"); fflush(stdout) }
  }
} catch { logError("Granite startup failed: \(error)"); exit(1) }
