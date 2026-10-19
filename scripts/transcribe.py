#!/usr/bin/env python3
"""
أداة استخراج الحوار (تفريغ نصي) من ملفات الفيديو أو الصوت باستخدام Whisper محلياً.

الاستخدام:
  python3 scripts/transcribe.py <ملف فيديو أو صوت> [--lang ar] [--out النص.txt] [--srt]

أمثلة:
  python3 scripts/transcribe.py video.mp4
  python3 scripts/transcribe.py video.mp4 --lang en --srt --model small

المتطلبات:
  pip install sherpa-onnx numpy
  ffmpeg
  نموذج Whisper (sherpa-onnx-whisper-turbo أو small) ونموذج silero_vad.onnx داخل STT_MODEL_DIR
  (الافتراضي: /opt/stt). التحميل:
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
"""

import argparse
import os
import subprocess
import sys

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16000
MODEL_DIR = os.environ.get("STT_MODEL_DIR", "/opt/stt")


def load_audio(path):
    """تحويل أي ملف فيديو/صوت إلى صوت أحادي 16kHz عبر ffmpeg."""
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path,
           "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def model_file(model, name):
    base = os.path.join(MODEL_DIR, f"sherpa-onnx-whisper-{model}", f"{model}-{name}")
    return f"{base}.onnx" if os.path.exists(f"{base}.onnx") else f"{base}.int8.onnx"


def build_recognizer(model, lang):
    return sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=model_file(model, "encoder"),
        decoder=model_file(model, "decoder"),
        tokens=os.path.join(MODEL_DIR, f"sherpa-onnx-whisper-{model}", f"{model}-tokens.txt"),
        language=lang,
        task="transcribe",
        num_threads=os.cpu_count() or 2,
    )


def build_vad():
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = os.path.join(MODEL_DIR, "silero_vad.onnx")
    config.silero_vad.min_silence_duration = 0.4
    config.silero_vad.max_speech_duration = 25  # Whisper يعالج حتى 30 ثانية لكل مقطع
    config.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=600)


def speech_segments(samples):
    vad = build_vad()
    window = vad.config.silero_vad.window_size
    for i in range(0, len(samples), window):
        vad.accept_waveform(samples[i:i + window])
        while not vad.empty():
            yield vad.front.start, vad.front.samples
            vad.pop()
    vad.flush()
    while not vad.empty():
        yield vad.front.start, vad.front.samples
        vad.pop()


def fmt_time(seconds, srt=False):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if srt:
        return f"{h:02d}:{m:02d}:{s:02d},{int((seconds % 1) * 1000):03d}"
    return f"{h:02d}:{m:02d}:{s:02d}"


def main():
    parser = argparse.ArgumentParser(description="استخراج الحوار من فيديو أو صوت")
    parser.add_argument("input")
    parser.add_argument("--lang", default="ar", help="لغة الكلام (ar, en, ...)")
    parser.add_argument("--model", default="turbo",
                        help="نموذج Whisper: turbo (أدق للعربية) أو small (أسرع)")
    parser.add_argument("--out", help="ملف النص (الافتراضي: بجانب الملف الأصلي)")
    parser.add_argument("--srt", action="store_true", help="إنشاء ملف ترجمة SRT أيضاً")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"❌ الملف غير موجود: {args.input}")

    print("🎵 جاري قراءة الصوت...", file=sys.stderr)
    samples = load_audio(args.input)
    recognizer = build_recognizer(args.model, args.lang)

    results = []
    for start, seg in speech_segments(samples):
        stream = recognizer.create_stream()
        # هامش صوتي قبل وبعد المقطع حتى لا تُقطع نهايات الكلمات
        lo = max(0, start - int(0.2 * SAMPLE_RATE))
        hi = min(len(samples), start + len(seg) + int(0.5 * SAMPLE_RATE))
        padded = np.concatenate([samples[lo:hi], np.zeros(SAMPLE_RATE, dtype=np.float32)])
        stream.accept_waveform(SAMPLE_RATE, padded)
        recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        if text:
            begin = start / SAMPLE_RATE
            end = begin + len(seg) / SAMPLE_RATE
            results.append((begin, end, text))
            print(f"[{fmt_time(begin)}] {text}", file=sys.stderr)

    base = os.path.splitext(args.out or args.input)[0]
    txt_path = args.out or f"{base}.txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        for begin, _, text in results:
            f.write(f"[{fmt_time(begin)}] {text}\n")

    if args.srt:
        with open(f"{base}.srt", "w", encoding="utf-8") as f:
            for i, (begin, end, text) in enumerate(results, 1):
                f.write(f"{i}\n{fmt_time(begin, True)} --> {fmt_time(end, True)}\n{text}\n\n")

    print(f"✅ تم حفظ النص: {txt_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
