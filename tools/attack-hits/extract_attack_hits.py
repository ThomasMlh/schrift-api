"""
Counts the hits of every attack animation of the game models, which the master tables do not give
for melee attacks. Each model bundle (rmfs/<resource_3d_id>.byte) holds a text asset listing the events
of its animations; every OnStartedHitJudge event opens one hit window.

Writes attack_hits.csv (resource_3d_id, clip, variation_index, hits), read by the sync next to the
other tables: put it in the game-db language folder of the primary language.

Usage: python extract_attack_hits.py <rmfs folder> <output csv>
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


def main(rmfs, output):
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

    with open(output, 'w', newline='', encoding='utf-8') as file:
        writer = csv.writer(file)
        writer.writerow(['resource_3d_id', 'clip', 'variation_index', 'hits'])
        writer.writerows(rows)
    print(f'{len({row[0] for row in rows})} models, {len(rows)} rows -> {output}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
