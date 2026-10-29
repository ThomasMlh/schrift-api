"""
Counts the hits of every attack animation of the game models, which the master tables do not give
for melee attacks. Each model bundle (rmfs/<resource_3d_id>.byte) holds a text asset listing the events
of its animations; every OnStartedHitJudge event opens one hit window.

Writes attack_hits.csv (resource_3d_id, clip, variation_index, hits), read by the sync next to the
other tables: put it in the game-db language folder of the primary language.

A dump only holds the models the client downloaded. Pass the previous attack_hits.csv to keep the
models missing from this dump: they keep their rows, the models found again are replaced.

Usage: python extract_attack_hits.py <rmfs folder> <output csv> [previous csv]
"""
import csv
import os
import sys
from collections import Counter

import UnityPy

HIT_EVENT = 'OnStartedHitJudge'
# Position of the variation index (m_character_attack.variation_index) in a hit event; older
# bundles stop before it, their hits all use the first variation
VARIATION_FIELD = 18


def clip_hits(script):
    """{(clip, variation_index): hits} from the event list of a model."""
    hits = Counter()
    clip = None
    for line in script.split('\r\n'):
        fields = line.split(',')
        # Clip header: name, animation path, number of events
        if len(fields) == 3 and fields[2].isdigit():
            clip = fields[0]
        elif clip and fields[0] == HIT_EVENT:
            variation = fields[VARIATION_FIELD] if len(fields) > VARIATION_FIELD and fields[VARIATION_FIELD].isdigit() else '0'
            hits[(clip, variation)] += 1
    return hits


def model_hits(path):
    env = UnityPy.load(path)
    for obj in env.objects:
        if obj.type.name != 'TextAsset':
            continue
        script = obj.read().m_Script
        text = script if isinstance(script, str) else bytes(script).decode('utf-8', 'replace')
        if HIT_EVENT in text:
            return clip_hits(text)
    return Counter()


def read_previous(path):
    with open(path, newline='', encoding='utf-8') as file:
        return [(r['resource_3d_id'], r['clip'], r['variation_index'], int(r['hits'])) for r in csv.DictReader(file)]


def main(rmfs, output, previous=None):
    rows = []
    for name in sorted(os.listdir(rmfs)):
        if not name.endswith('_mdl.byte'):
            continue
        model = name[:-len('.byte')]
        try:
            hits = model_hits(os.path.join(rmfs, name))
        except Exception as error:  # an unreadable bundle only leaves its model without hits
            print(f'{name}: {error}', file=sys.stderr)
            continue
        rows.extend((model, clip, variation, count) for (clip, variation), count in sorted(hits.items()))

    found = {row[0] for row in rows}
    kept = [row for row in read_previous(previous) if row[0] not in found] if previous else []
    rows = sorted(rows + kept)

    with open(output, 'w', newline='', encoding='utf-8') as file:
        writer = csv.writer(file)
        writer.writerow(['resource_3d_id', 'clip', 'variation_index', 'hits'])
        writer.writerows(rows)
    print(f'{len(found)} models from the dump, {len({row[0] for row in kept})} kept from the previous file, '
          f'{len({row[0] for row in rows})} models, {len(rows)} rows -> {output}')


if __name__ == '__main__':
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(*sys.argv[1:])
