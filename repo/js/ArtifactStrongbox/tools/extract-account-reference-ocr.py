"""开发用：对参考图运行 RapidOCR，输出实际 OCR 框。不是 BGI 运行依赖。

需要Node及Python的 rapidocr-onnxruntime；模型/预处理可能与BGI不同，不能代替游戏实测。
"""
import argparse
import importlib.metadata
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, default=root / "reference-images")
    parser.add_argument("--output", type=Path, default=root / "tools/fixtures/account-reference-ocr.json")
    args = parser.parse_args()
    engine = RapidOCR()
    # 直接从JS读取各阶段ROI，避免开发工具与运行代码的裁剪范围漂移。
    script = "import {accountCaptureTargets} from './utils/account-reader.js'; console.log(JSON.stringify(Object.fromEntries(['page','identity','detail','recommendation','setDialog','identityRetry','detailRetry'].map(s=>[s,accountCaptureTargets(s)]))))"
    scopes = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=root, text=True))
    fixtures = []
    retries = []
    def infer(image, targets, initial=None):
        items = list(initial or [])
        for target in targets:
            x, y, width, height = target["region"]
            result, _ = engine(image[y:y+height, x:x+width], use_cls=False)
            for box, text, confidence in result or []:
                left, top = min(p[0] for p in box), min(p[1] for p in box)
                right, bottom = max(p[0] for p in box), max(p[1] for p in box)
                item = dict(text=text, x=x+left, y=y+top, width=right-left,
                            height=bottom-top, confidence=float(confidence))
                if target.get("field"):
                    item["ocrField"] = target["field"]
                if not any(old.get("ocrField") == item.get("ocrField") and all(old[k] == item[k] for k in ("text", "x", "y", "width", "height")) for old in items):
                    items.append(item)
        items.sort(key=lambda item: (item["y"], item["x"]))
        return items
    for path in sorted(args.images.glob("*.png")):
        image = np.array(Image.open(path).convert("RGB"))[:, :, ::-1].copy()
        scope = "recommendation" if "推荐" in path.name else "detail" if "详情页" in path.name else "identity" if "角色界面" in path.name else "page"
        items = infer(image, scopes[scope])
        fixtures.append(dict(file=path.name, scope=scope, items=items))
        if scope in ("detail", "identity"):
            retry_scope = scope + "Retry"
            retry_items = infer(image, [target for target in scopes[retry_scope] if target.get("field")], items)
            retries.append(dict(file=path.name, scope=retry_scope, items=retry_items))
        print(json.dumps(dict(file=path.name, boxes=len(items)), ensure_ascii=True), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dict(
        source="RapidOCR actual inference on local reference images; not BGI capture",
        engineVersion=importlib.metadata.version("rapidocr-onnxruntime"), images=fixtures, retryImages=retries),
        ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
