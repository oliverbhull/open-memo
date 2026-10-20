// Private pipe adapter for the installed NeMo-Speech C ABI. Model stays resident.
// Requests: byte opcode + uint32 payload bytes (little endian); PCM is mono i16/16k.
// Responses: byte status + uint32 UTF-8 byte count + text. Initial empty success = ready.
#include <nemo_speech/asr.h>
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>
#include <stdexcept>
#include <fcntl.h>
#include <io.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

static void check(nemo_speech_asr_status status) {
    if (status != NEMO_SPEECH_ASR_OK) {
        const char* error = nemo_speech_asr_last_error();
        throw std::runtime_error(error ? error : "Nemotron runtime failure");
    }
}
static void respond(uint8_t status, const std::string& text) {
    uint32_t size = static_cast<uint32_t>(text.size());
    fwrite(&status, 1, 1, stdout); fwrite(&size, 4, 1, stdout);
    fwrite(text.data(), 1, size, stdout); fflush(stdout);
}
static void append(std::string& text, const char* part) {
    if (!part || !*part) return;
    if (!text.empty()) text += ' ';
    text += part;
}
static int worker_main(int argc, char** argv) {
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    nemo_speech_asr_recognizer* recognizer = nullptr;
    nemo_speech_asr_stream* stream = nullptr;
    int exit_code = 0;
    try {
        if (argc != 2) throw std::runtime_error("Expected model path");
        nemo_speech_asr_backend_config backend{}; backend.size=sizeof(backend); backend.gpu=-1;
        nemo_speech_asr_model_config model{}; model.size=sizeof(model); model.path=argv[1];
        nemo_speech_asr_streaming_config policy{}; policy.size=sizeof(policy);
        policy.chunk_size=1.6f; policy.ctc_left_padding=1.6f; policy.ctc_right_padding=0.4f;
        policy.rnnt_right_context=1; // 160 ms cache-aware streaming geometry.
        nemo_speech_asr_recognizer_config config{}; config.size=sizeof(config);
        config.backend=&backend; config.model=&model; config.streaming=&policy;
        check(nemo_speech_asr_create(&config, &recognizer));
        respond(0, "");
        std::string transcript;
        auto drain = [&]() {
            while (true) {
                nemo_speech_asr_result* result=nullptr;
                check(nemo_speech_asr_stream_next(stream, &result));
                if (!result) break;
                bool final = nemo_speech_asr_result_is_final(result);
                if (final) append(transcript,nemo_speech_asr_result_transcript(result,0));
                nemo_speech_asr_result_destroy(result);
                if (!final) break;
            }
        };
        uint8_t opcode; uint32_t size;
        while (fread(&opcode,1,1,stdin)==1) {
            if (fread(&size,4,1,stdin)!=1 || size>16000*2*600) break;
            std::vector<uint8_t> bytes(size);
            if (size && fread(bytes.data(),1,size,stdin)!=size) break;
            if (opcode==1) {
                if (stream) nemo_speech_asr_stream_close(stream);
                stream=nullptr; transcript.clear();
                auto options=nemo_speech_asr_recognition_options_default();
                options.language_code="en-US"; options.interim_results=true;
                check(nemo_speech_asr_streaming_recognize(recognizer,&options,&stream));
            } else if (opcode==2) {
                if (!stream || size%2) throw std::runtime_error("Invalid audio stream");
                std::vector<float> audio(size/2);
                for(size_t i=0;i<audio.size();i++) {
                    int16_t sample=static_cast<int16_t>(bytes[2*i] | (uint16_t(bytes[2*i+1])<<8));
                    audio[i]=sample/32768.0f;
                }
                check(nemo_speech_asr_stream_push_f32(stream,audio.data(),audio.size(),16000));
                drain();
            } else if (opcode==3) {
                if (!stream) throw std::runtime_error("No active stream");
                check(nemo_speech_asr_stream_finish(stream)); drain();
                nemo_speech_asr_stream_close(stream); stream=nullptr;
                respond(0,transcript); transcript.clear();
            } else if (opcode==4) {
                if(stream) nemo_speech_asr_stream_close(stream);
                stream=nullptr; transcript.clear();
            } else throw std::runtime_error("Unknown stream opcode");
        }
    } catch(const std::exception& error) { respond(1,error.what()); exit_code = 1; }
    if(stream) nemo_speech_asr_stream_close(stream);
    if(recognizer) nemo_speech_asr_destroy(recognizer);
    return exit_code;
}

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
