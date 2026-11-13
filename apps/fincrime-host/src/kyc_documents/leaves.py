"""Leaf-by-leaf pairing of two catalog extraction values for one document type.

Used by evaluation (gold against a route) and adjudication (one route against another). Scalar
fields and objects pair by path. Row arrays (ownership rows, accounts, signatures) pair rows by
content, because two readers can list the same rows in a different order: each left row takes the
right row with the most equivalent scalar members, and unmatched rows pair with nothing.

Each pair keeps both sides' own JSON Pointer (`/extracted_fields/accounts/1/currency`), so a caller
can find that side's observation, status and spans.
"""
from __future__ import annotations

from .comparators import compare, comparator_for_leaf
from .fields import FIELDS, OBJECTS
from .profiles import PROFILES

ROW_KEY_KINDS = ("text", "identifier", "date", "decimal", "percentage")


def scalar_leaves(value, kind, path, member):
    """(path, member, kind, value) for each scalar leaf of a value; None yields nothing."""
    if value is None:
        return
    if kind in OBJECTS:
        for name, member_kind in OBJECTS[kind].items():
            yield from scalar_leaves(value.get(name), member_kind, f"{path}/{name}", name)
    elif kind == "texts":
        for index, item in enumerate(value):
            yield f"{path}/{index}", member, "text", item
    elif kind.startswith("["):
        raise AssertionError("row arrays are aligned before leaf pairing")
    else:
        yield path, member, kind, value


def row_score(left: dict, right: dict, kind: str) -> int:
    return sum(1 for name, member_kind in OBJECTS[kind].items()
               if member_kind in ROW_KEY_KINDS and left.get(name) is not None and right.get(name) is not None
               and compare(comparator_for_leaf(name, member_kind), left[name], right[name]) == "equivalent")


def align_rows(left_rows: list, right_rows: list, kind: str) -> list[tuple[int | None, int | None]]:
    """Greedy best-match alignment by equivalent members, as index pairs; unmatched rows pair with None."""
    remaining = list(range(len(right_rows)))
    pairs: list[tuple[int | None, int | None]] = []
    for i, left in enumerate(left_rows):
        best = max(remaining, key=lambda j: row_score(left, right_rows[j], kind), default=None)
        if best is not None and row_score(left, right_rows[best], kind) > 0:
            remaining.remove(best)
            pairs.append((i, best))
        else:
            pairs.append((i, None))
    pairs.extend((None, j) for j in remaining)
    return pairs


def aligned_leaves(document_type: str, left: dict | None, right: dict | None) -> list[dict]:
    """Every leaf present on either side, paired: field, member, kind, both values and both pointers.

    `path` is the pairing's display path: row pairs are numbered in alignment order, so `accounts/0/currency`
    is the first aligned row, whichever index it had on each side.
    """
    left, right = left or {}, right or {}
    out: list[dict] = []
    for field in PROFILES[document_type].field_names:
        kind = FIELDS[field].value_type
        lv, rv = left.get(field), right.get(field)
        if kind.startswith("[") and kind[1:-1] in OBJECTS:
            row_kind = kind[1:-1]
            lrows, rrows = lv or [], rv or []
            for n, (i, j) in enumerate(align_rows(lrows, rrows, row_kind)):
                ll = {p.split("/", 1)[1]: (m, k, v) for p, m, k, v in scalar_leaves(lrows[i], row_kind, "_", None)} if i is not None else {}
                rl = {p.split("/", 1)[1]: (m, k, v) for p, m, k, v in scalar_leaves(rrows[j], row_kind, "_", None)} if j is not None else {}
                for leaf in sorted(ll.keys() | rl.keys()):
                    member, member_kind, _ = ll.get(leaf) or rl[leaf]
                    out.append({"path": f"{field}/{n}/{leaf}", "field": field, "member": member, "kind": member_kind,
                                "left": ll[leaf][2] if leaf in ll else None, "right": rl[leaf][2] if leaf in rl else None,
                                "left_pointer": f"/extracted_fields/{field}/{i}/{leaf}" if i is not None else None,
                                "right_pointer": f"/extracted_fields/{field}/{j}/{leaf}" if j is not None else None})
            continue
        ll = {p: (m, k, v) for p, m, k, v in scalar_leaves(lv, kind, field, field)}
        rl = {p: (m, k, v) for p, m, k, v in scalar_leaves(rv, kind, field, field)}
        for path in sorted(ll.keys() | rl.keys()):
            member, member_kind, _ = ll.get(path) or rl[path]
            out.append({"path": path, "field": field, "member": member, "kind": member_kind,
                        "left": ll[path][2] if path in ll else None, "right": rl[path][2] if path in rl else None,
                        "left_pointer": "/extracted_fields/" + path, "right_pointer": "/extracted_fields/" + path})
    return out
