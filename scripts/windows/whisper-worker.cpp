// Private pipe protocol: request = u32 LE sample count + signed i16 LE PCM.
// Response = u8 status (0 OK, 1 error) + u32 LE UTF-8 size + UTF-8 text.
// An empty OK response signals that the persistent model is ready.
#include "whisper.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#endif

static bool respond(uint8_t status, const std::string &text) {
    const uint32_t size = static_cast<uint32_t>(text.size());
    uint8_t header[] = {status, uint8_t(size), uint8_t(size >> 8), uint8_t(size >> 16), uint8_t(size >> 24)};
    return fwrite(header, 1, 5, stdout) == 5 &&
           fwrite(text.data(), 1, text.size(), stdout) == text.size() && fflush(stdout) == 0;
}
static int worker_main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc != 2) { respond(1, "Usage: memo-whisper-worker MODEL"); return 1; }
    auto context_params = whisper_context_default_params();
    context_params.use_gpu = false;
    auto *context = whisper_init_from_file_with_params(argv[1], context_params);
    if (!context) { respond(1, "Failed to load Whisper model"); return 1; }
    // Explicit opt-in for local acceleration trials; never silently benchmark a
    // CPU fallback as GPU inference. The shipped CPU build needs no extra runtime.
    if (const char *device = std::getenv("MEMO_WHISPER_OPENVINO_DEVICE")) {
        const char *encoder = std::getenv("MEMO_WHISPER_OPENVINO_ENCODER");
        const char *cache = std::getenv("MEMO_WHISPER_OPENVINO_CACHE");
        if (whisper_ctx_init_openvino_encoder(context, encoder, device, cache) != 0) {
            respond(1, "Requested OpenVINO encoder initialization failed");
            whisper_free(context);
            return 1;
        }
    }
    if (!respond(0, "")) { whisper_free(context); return 1; }
    uint8_t header[4];
    int exit_code = 0;
    while (true) {
        const size_t received = fread(header, 1, 4, stdin);
        if (received == 0) break;
        if (received != 4) { respond(1, "Truncated request header"); exit_code = 1; break; }
        const uint32_t count = uint32_t(header[0]) | uint32_t(header[1]) << 8 |
                               uint32_t(header[2]) << 16 | uint32_t(header[3]) << 24;
        if (count > 16000 * 60 * 10) { respond(1, "Audio exceeds ten minutes"); exit_code = 1; break; }
        std::vector<uint8_t> bytes(size_t(count) * 2);
        if (fread(bytes.data(), 1, bytes.size(), stdin) != bytes.size()) {
            respond(1, "Truncated PCM audio"); exit_code = 1; break;
        }
        std::vector<float> pcm(count);
        for (size_t i = 0; i < count; ++i) {
            const int16_t sample = static_cast<int16_t>(uint16_t(bytes[2*i]) | uint16_t(bytes[2*i+1]) << 8);
            pcm[i] = float(sample) / 32768.0f;
        }
        if (count == 0) { if (!respond(0, "")) break; continue; }
        auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
        params.n_threads = 4;
        params.language = "en";
        params.no_context = true; // Never carry words from the previous recording.
        params.no_timestamps = true;
        params.print_realtime = false;
        params.print_progress = false;
        params.print_timestamps = false;
        params.print_special = false;
        // Match the CLI's existing defaults; model residency does not trade accuracy.
        params.greedy.best_of = 5;
        params.beam_search.beam_size = 5;
        if (whisper_full(context, params, pcm.data(), int(pcm.size())) != 0) {
            respond(1, "Whisper inference failed"); exit_code = 1; break;
        }
        std::string text;
        for (int i = 0; i < whisper_full_n_segments(context); ++i)
            text += whisper_full_get_segment_text(context, i);
        if (!respond(0, text)) break;
    }
    whisper_free(context);
    return exit_code;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **wide_argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    std::vector<std::string> utf8_args;
    utf8_args.reserve(argc);
    for (int i = 0; i < argc; ++i) {
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, nullptr, 0, nullptr, nullptr);
        if (!size) { respond(1, "Invalid UTF-16 model argument"); return 1; }
        std::string argument(size, '\0');
        if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, argument.data(), size, nullptr, nullptr)) {
            respond(1, "Could not convert model argument to UTF-8"); return 1;
        }
        argument.pop_back();
        utf8_args.push_back(std::move(argument));
    }
    std::vector<char *> argv;
    for (auto &argument : utf8_args) argv.push_back(argument.data());
    return worker_main(argc, argv.data());
}
#else
int main(int argc, char **argv) { return worker_main(argc, argv); }
#endif
