"""剪讲：视频里的人声转成带时间的文字（faster-whisper）。
用法：python3 jj_hear.py <音视频文件> [模型 small] [语言 zh/en，空着自动识别]
输出：JSON 数组 [{start, end, text}] 到标准输出。
"""
import json
import sys

from faster_whisper import WhisperModel


def main():
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "small"
    lang = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(path, language=lang, vad_filter=True, initial_prompt="以下是普通话的句子。" if lang == "zh" else None)
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
