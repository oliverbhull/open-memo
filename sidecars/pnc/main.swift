import CoreML
import Foundation

private let maxTokens = 128
private let clsId = 101
private let sepId = 102
private let unknownId = 100
private let punctuation = ["", ",", ".", "?"]

private func logError(_ message: String) {
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

private final class WordPieceTokenizer {
  private let vocabulary: [String: Int]

  init(vocabularyURL: URL) throws {
    let contents = try String(contentsOf: vocabularyURL, encoding: .utf8)
    vocabulary = Dictionary(uniqueKeysWithValues: contents.split(separator: "\n", omittingEmptySubsequences: false)
      .enumerated().map { (String($0.element), $0.offset) })
  }

  private func pieces(for rawWord: String) -> [Int] {
    let normalized = rawWord.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
    let characters = Array(normalized)
    if characters.count > 100 { return [unknownId] }
    var result: [Int] = []
    var start = 0
    while start < characters.count {
      var end = characters.count
      var match: Int?
      while end > start {
        let prefix = start == 0 ? "" : "##"
        let candidate = prefix + String(characters[start..<end])
        if let id = vocabulary[candidate] { match = id; break }
        end -= 1
      }
      guard let match else { return [unknownId] }
      result.append(match)
      start = end
    }
    return result
  }

  func encode(_ words: ArraySlice<String>) -> (ids: [Int32], mask: [Int32], words: [String], firstTokens: [Int]) {
    var ids = [clsId]
    var firstTokens: [Int] = []
    var acceptedWords: [String] = []
    for word in words {
      let wordPieces = pieces(for: word)
      if ids.count + wordPieces.count + 1 > maxTokens { break }
      firstTokens.append(ids.count)
      acceptedWords.append(word)
      ids.append(contentsOf: wordPieces)
    }
    ids.append(sepId)
    var mask = Array(repeating: Int32(1), count: ids.count)
    ids += Array(repeating: 0, count: maxTokens - ids.count)
    mask += Array(repeating: 0, count: maxTokens - mask.count)
    return (ids.map(Int32.init), mask, acceptedWords, firstTokens)
  }
}

private final class PunctuationRuntime {
  private let model: MLModel
  private let tokenizer: WordPieceTokenizer

  init(modelURL: URL, vocabularyURL: URL) throws {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    model = try MLModel(contentsOf: modelURL, configuration: configuration)
    tokenizer = try WordPieceTokenizer(vocabularyURL: vocabularyURL)
  }

  private func array(_ values: [Int32]) throws -> MLMultiArray {
    let result = try MLMultiArray(shape: [1, maxTokens as NSNumber], dataType: .int32)
    let pointer = result.dataPointer.bindMemory(to: Int32.self, capacity: values.count)
    for index in values.indices { pointer[index] = values[index] }
    return result
  }

  private func bestLabel(_ logits: MLMultiArray, token: Int, labels: Int) -> Int {
    var best = 0
    var bestValue = -Float.infinity
    for label in 0..<labels {
      let value = logits[[0, token as NSNumber, label as NSNumber]].floatValue
      if value > bestValue { best = label; bestValue = value }
    }
    return best
  }

  private func formatChunk(_ words: ArraySlice<String>) throws -> [String] {
    let encoded = tokenizer.encode(words)
    guard !encoded.words.isEmpty else { return Array(words) }
    let provider = try MLDictionaryFeatureProvider(dictionary: [
      "input_ids": MLFeatureValue(multiArray: try array(encoded.ids)),
      "attention_mask": MLFeatureValue(multiArray: try array(encoded.mask)),
    ])
    let output = try model.prediction(from: provider)
    guard
      let punctLogits = output.featureValue(for: "punctuation_logits")?.multiArrayValue,
      let capitLogits = output.featureValue(for: "capitalization_logits")?.multiArrayValue
    else { throw NSError(domain: "MemoPnC", code: 2, userInfo: [NSLocalizedDescriptionKey: "Core ML outputs missing"]) }

    var formatted: [String] = []
    for index in encoded.words.indices {
      let token = encoded.firstTokens[index]
      var word = encoded.words[index]
      if bestLabel(capitLogits, token: token, labels: 2) == 1,
         let first = word.first {
        word.replaceSubrange(word.startIndex...word.startIndex, with: String(first).uppercased())
      }
      let mark = punctuation[bestLabel(punctLogits, token: token, labels: punctuation.count)]
      if !mark.isEmpty, word.last.map({ !punctuation.contains(String($0)) }) ?? false { word += mark }
      formatted.append(word)
    }
    return formatted
  }

  func format(_ text: String) throws -> String {
    let started = CFAbsoluteTimeGetCurrent()
    let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    guard !words.isEmpty else { return text }
    var formatted: [String] = []
    while formatted.count < words.count {
      let chunk = try formatChunk(words[formatted.count...])
      guard !chunk.isEmpty else { return text }
      formatted.append(contentsOf: chunk)
    }
    let elapsed = (CFAbsoluteTimeGetCurrent() - started) * 1_000
    logError(String(format: "TIMING:pnc_ms=%.1f words=%d", elapsed, words.count))
    return formatted.joined(separator: " ")
  }
}

private struct Request: Decodable { let id: String; let text: String }
private struct Response: Encodable { let id: String; let text: String; let error: String? }

private var arguments = CommandLine.arguments
private func value(after flag: String) -> String? {
  guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

guard
  let modelPath = value(after: "--model-path"),
  let vocabularyPath = value(after: "--vocabulary-path"),
  arguments.contains("--worker")
else {
  logError("usage: memo-pnc --model-path MODEL.mlmodelc --vocabulary-path tokenizer.vocab --worker")
  exit(2)
}

do {
  let runtime = try PunctuationRuntime(
    modelURL: URL(fileURLWithPath: modelPath),
    vocabularyURL: URL(fileURLWithPath: vocabularyPath)
  )
  _ = try runtime.format("memo is ready")
  print("READY"); fflush(stdout)
  while let line = readLine() {
    do {
      let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
      let response = Response(id: request.id, text: try runtime.format(request.text), error: nil)
      print(String(data: try JSONEncoder().encode(response), encoding: .utf8)!); fflush(stdout)
    } catch {
      let id = (try? JSONDecoder().decode(Request.self, from: Data(line.utf8)).id) ?? ""
      let response = Response(id: id, text: "", error: error.localizedDescription)
      print(String(data: try JSONEncoder().encode(response), encoding: .utf8)!); fflush(stdout)
    }
  }
} catch {
  logError("Memo PnC failed to start: \(error.localizedDescription)")
  exit(1)
}
