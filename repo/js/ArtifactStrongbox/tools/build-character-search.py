"""一次性生成搜索字典；运行时不依赖Python/pypinyin，不读取账号文件。"""
import hashlib
import json
from importlib.metadata import version
from pathlib import Path
from pypinyin import lazy_pinyin

root = Path(__file__).resolve().parents[1]
dictionary_path = root / "assets/character-names.json"
dictionary = json.loads(dictionary_path.read_text(encoding="utf-8"))
names = [row["name"] for row in dictionary["characters"]]
names += ["人偶A", "人偶B"] + [f"旅行者（{element}）" for element in "风岩雷草水火冰"]
# 搜索兼容多音字的两种常见输入，不据此改变角色官方名称或评分身份。
alternatives = {
    "白术": ["bai zhu", "bai shu"],
    "重云": ["chong yun", "zhong yun"],
    "行秋": ["xing qiu", "hang qiu"],
    "八重神子": ["ba chong shen zi", "ba zhong shen zi"],
    "茜特菈莉": ["qian te la li", "xi te la li"],
}
entries = {}
for name in sorted(set(names)):
    syllables = [part.lower() for part in lazy_pinyin(name) if part]
    # 去除名称分隔符，保留人偶A/B和旅行者元素的区分。
    syllables = ["".join(char for char in part if char.isalnum()) for part in syllables]
    syllables = [part for part in syllables if part]
    variants = [syllables] + [value.split() for value in alternatives.get(name, [])]
    aliases = list(dict.fromkeys(key for variant in variants for key in
                                ("".join(variant), "".join(part[0] for part in variant))))
    entries[name] = {"pinyin": "".join(syllables), "initials": "".join(part[0] for part in syllables), "aliases": aliases}
output = {"schemaVersion": 1, "nameDictionarySha256": hashlib.sha256(dictionary_path.read_bytes()).hexdigest(),
          "generator": {"package": "pypinyin", "version": version("pypinyin"), "license": "MIT",
                        "source": "https://github.com/mozillazg/python-pinyin"},
          "polyphonicSearchAliases": alternatives, "entries": entries}
(root / "assets/character-search.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Generated {len(entries)} character search entries with pypinyin {version('pypinyin')}")
