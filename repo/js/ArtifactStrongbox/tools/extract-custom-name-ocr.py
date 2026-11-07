"""开发验证：识别用户提供的自定义名称参考图，不是BGI运行依赖。"""
import json
import subprocess
from pathlib import Path
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

root = Path(__file__).resolve().parent.parent
regions = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {ACCOUNT_REGIONS as r} from './utils/account-reader.js'; console.log(JSON.stringify(['header','menu','characterName','characterLevel','biography','archiveBiography'].map(field=>({field,region:r[field]}))))"], cwd=root, text=True, encoding='utf-8'))
engine = RapidOCR()
examples = []
for name in ['自定义名称-人偶.png', '自定义名称-流浪者图鉴.png']:
    image = np.array(Image.open(root / 'reference-images' / name).convert('RGB'))[:, :, ::-1].copy()
    items = []
    for target in regions:
        x, y, width, height = target['region']
        result, _ = engine(image[y:y+height, x:x+width], use_cls=False)
        for box, text, confidence in result or []:
            left, top = min(p[0] for p in box), min(p[1] for p in box)
            right, bottom = max(p[0] for p in box), max(p[1] for p in box)
            items.append(dict(text=text, x=x+left, y=y+top, width=right-left, height=bottom-top,
                              ocrField=target['field'], confidence=float(confidence)))
    examples.append(dict(file=name, items=items))
    print(json.dumps(dict(file=name, texts=[item['text'] for item in items]), ensure_ascii=True), flush=True)
(root / 'tools/fixtures/custom-name-ocr.json').write_text(json.dumps(dict(
    source='Actual RapidOCR on user reference images, 2026-10-26; not BGI game test', examples=examples),
    ensure_ascii=False, indent=2), encoding='utf-8')
