#!/usr/bin/env python3
"""免费配音：调用 edge-tts（微软 Edge 朗读接口），写出 MP3 和逐词时间。由 hj voice --engine edge 调用。
用法：edge_words.py --text 稿.txt --voice 音色 --rate +0% --pitch -4Hz --media out.mp3 --words out.json [--proxy URL]
"""
import argparse
import asyncio
import json
import sys


async def run(a):
    import edge_tts
    text = open(a.text, encoding='utf-8').read().strip()
    kw = dict(voice=a.voice, rate=a.rate, pitch=a.pitch, volume='+0%', boundary='WordBoundary')
    if a.proxy:
        kw['proxy'] = a.proxy
    words, sentences = [], []
    with open(a.media, 'wb') as f:
        async for c in edge_tts.Communicate(text, **kw).stream():
            if c['type'] == 'audio':
                f.write(c['data'])
            elif c['type'] in ('WordBoundary', 'SentenceBoundary'):
                item = {'text': c['text'], 'start': c['offset'] / 1e7, 'end': (c['offset'] + c['duration']) / 1e7}
                (words if c['type'] == 'WordBoundary' else sentences).append(item)
    json.dump({'words': words, 'sentences': sentences}, open(a.words, 'w', encoding='utf-8'), ensure_ascii=False)


def main():
    p = argparse.ArgumentParser()
    for k in ('text', 'voice', 'media', 'words'):
        p.add_argument('--' + k, required=True)
    p.add_argument('--rate', default='+0%')
    p.add_argument('--pitch', default='+0Hz')
    p.add_argument('--proxy')
    a = p.parse_args()
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        print('NO_EDGE_TTS', file=sys.stderr)
        return 3
    try:
        asyncio.run(run(a))
    except Exception as e:  # 接口是逆向的，偶尔 403 或超时
        print(f'{type(e).__name__}: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
