#!/usr/bin/env python3
"""
Transcribe a reCAPTCHA audio challenge using Vosk.
Usage: python3 audio_transcribe.py <audio_url>
Output: JSON with { "text": "transcribed text" } or { "error": "..." }
"""
import sys, json, urllib.request, subprocess, tempfile, os, wave, struct

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vosk-model', 'model')

def transcribe(audio_url):
    tmp_path = None
    wav_path = None
    try:
        # Download audio
        tmp_path = tempfile.mktemp(suffix='.mp3')
        wav_path = tempfile.mktemp(suffix='.wav')
        req = urllib.request.Request(audio_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            with open(tmp_path, 'wb') as f:
                f.write(resp.read())

        # Convert to WAV 16kHz mono PCM
        result = subprocess.run([
            'ffmpeg', '-y', '-i', tmp_path, '-ar', '16000', '-ac', '1',
            '-f', 'wav', '-acodec', 'pcm_s16le', wav_path
        ], capture_output=True, timeout=10)

        if result.returncode != 0 or not os.path.exists(wav_path):
            return {"error": f"ffmpeg failed: {result.stderr.decode()[:200]}"}

        # Use Vosk for recognition
        from vosk import Model, KaldiRecognizer
        model = Model(MODEL_PATH)
        
        with wave.open(wav_path, 'rb') as wf:
            rec = KaldiRecognizer(model, wf.getframerate())
            rec.SetWords(True)
            
            while True:
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                rec.AcceptWaveform(data)
            
            final = json.loads(rec.FinalResult())
            text = final.get('text', '').strip().lower()
            # reCAPTCHA expects lowercase letters only
            text = ''.join(c for c in text if c.isalpha() or c == ' ')
            
            if text:
                return {"text": text}
            else:
                return {"error": "no speech recognized", "raw": final}

    except Exception as e:
        return {"error": str(e)}
    finally:
        for p in [tmp_path, wav_path]:
            if p:
                try: os.unlink(p)
                except: pass

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: audio_transcribe.py <audio_url>"}))
        sys.exit(1)
    print(json.dumps(transcribe(sys.argv[1])))
