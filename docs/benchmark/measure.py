#!/usr/bin/env python3
# usage: python3 -I measure.py <bench dir>  -> prints a table and writes results.json
import glob, json, os, sys
from collections import defaultdict

B = sys.argv[1]
F = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens')
HOME = os.path.expanduser('~/.claude/projects')


def usage(sid):
    lead = glob.glob(os.path.join(HOME, '*', sid + '.jsonl'))
    if not lead:
        return None
    folder = os.path.dirname(lead[0])
    files = lead + sorted(glob.glob(os.path.join(folder, sid, 'subagents', '**', '*.jsonl'), recursive=True))
    by_model = defaultdict(lambda: dict.fromkeys(F + ('responses',), 0))
    lead_tot = dict.fromkeys(F, 0)
    workers = []
    seen = set(); ledger = None
    unfinished = 0
    for f in files:
        if os.path.basename(f) == 'journal.jsonl':
            continue
        meta = f[:-6] + '.meta.json'
        if f != files[0] and os.path.exists(meta):
            try:
                if not json.load(open(meta)).get('finished', True):
                    unfinished += 1
            except ValueError:
                pass
        wtot = dict.fromkeys(F, 0); wmodel = None
        for line in open(f, encoding='utf-8'):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('type') == 'cost-state' and f == files[0]:
                ledger = d.get('modelUsage')
            if d.get('type') != 'assistant':
                continue
            m = d.get('message') or {}; u = m.get('usage')
            key = m.get('id') or d.get('requestId') or d.get('uuid')
            if not u or key in seen:
                continue
            seen.add(key)
            model = m.get('model') or '?'
            t = by_model[model]
            for k in F:
                t[k] += u.get(k) or 0
                (lead_tot if f == files[0] else wtot)[k] += u.get(k) or 0
            t['responses'] += 1
            wmodel = model
        if f != files[0]:
            workers.append({'file': os.path.basename(f), 'model': wmodel, **wtot})
    led = {}
    for model, v in (ledger or {}).items():
        led[model] = {'input_tokens': v.get('inputTokens') or 0,
                      'cache_creation_input_tokens': v.get('cacheCreationInputTokens') or 0,
                      'cache_read_input_tokens': v.get('cacheReadInputTokens') or 0,
                      'output_tokens': v.get('outputTokens') or 0}
    return {'by_model': by_model, 'lead': lead_tot, 'workers': workers, 'ledger': led, 'unfinished': unfinished}


def tin(t):
    return t['input_tokens'] + t['cache_creation_input_tokens'] + t['cache_read_input_tokens']


out = {}
for d in sorted(glob.glob(os.path.join(B, 'runs', '*'))):
    name = os.path.basename(d)
    try:
        sid = open(os.path.join(d, 'session_id')).read().strip()
        secs = int(open(os.path.join(d, 'seconds')).read())
    except (OSError, ValueError):
        continue
    u = usage(sid)
    if not u:
        continue
    pt = open(os.path.join(d, 'posttest.txt')).read().strip().splitlines()
    tail = [l for l in pt if 'pass' in l.lower() or 'fail' in l.lower()][-2:]
    try:
        res = json.load(open(os.path.join(d, 'result.json')))
    except ValueError:
        res = {}
    out[name] = {'seconds': secs, 'tests': tail, 'test_exit': pt[-1] if pt else '?',
                 'num_turns': res.get('num_turns'), 'is_error': res.get('is_error'),
                 'by_model': u['by_model'], 'lead': u['lead'], 'workers': u['workers'],
                 'ledger': u['ledger'], 'unfinished': u['unfinished'],
                 'diffstat': open(os.path.join(d, 'diffstat.txt')).read().strip().splitlines()[-1:]}
    tot_in = sum(tin(t) for t in u['by_model'].values())
    tot_out = sum(t['output_tokens'] for t in u['by_model'].values())
    led_in = sum(tin(t) for t in u['ledger'].values()); led_out = sum(t['output_tokens'] for t in u['ledger'].values())
    print(f"{name:14} {secs:5}s in {tot_in/1e6:6.2f}M out {tot_out/1e3:6.1f}k | ledger in {led_in/1e6:6.2f}M out {led_out/1e3:6.1f}k | "
          f"lead in {tin(u['lead'])/1e6:5.2f}M | workers {len(u['workers'])} unfinished {u['unfinished']} | tests {tail} exit {out[name]['test_exit']}")
    for model, t in sorted(u['by_model'].items()):
        print(f"    {model:22} in {tin(t)/1e6:6.2f}M (new {t['input_tokens']}, write {t['cache_creation_input_tokens']}, read {t['cache_read_input_tokens']}) out {t['output_tokens']} resp {t['responses']}")
json.dump(out, open(os.path.join(B, 'results.json'), 'w'), indent=1)
