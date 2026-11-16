#!/usr/bin/env python3
# usage: python3 -I measure.py ARG [ARG...]  -> prints a table and writes results.json into the first folder
# ARG is a bench folder, or FOLDER=REGEX to read only run folders whose name matches REGEX (re.search)
import glob, json, os, re, statistics, sys
from collections import defaultdict

if len(sys.argv) < 2:
    sys.exit(__doc__ if __doc__ else 'usage: measure.py ARG [ARG...]')
ARGS = []
for a in sys.argv[1:]:
    if os.path.isdir(a) or '=' not in a:
        ARGS.append((a, None))
    else:
        f, r = a.rsplit('=', 1)
        ARGS.append((f, re.compile(r)))
B = ARGS[0][0]
PRICES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prices.json')))['models']
COMP = ('input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output')
F = ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens')
HOME = os.path.expanduser('~/.claude/projects')


def usage(sid):
    lead = glob.glob(os.path.join(HOME, '*', sid + '.jsonl'))
    if not lead:
        return None
    folder = os.path.dirname(lead[0])
    files = lead + sorted(glob.glob(os.path.join(folder, sid, 'subagents', '**', '*.jsonl'), recursive=True))
    by_model = defaultdict(lambda: dict.fromkeys(F + ('responses',), 0))
    comp = defaultdict(lambda: dict.fromkeys(COMP, 0))
    lead_comp = defaultdict(lambda: dict.fromkeys(COMP, 0))
    work_comp = defaultdict(lambda: dict.fromkeys(COMP, 0))
    split_missing = False
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
            cc = u.get('cache_creation')
            if isinstance(cc, dict):
                w5 = cc.get('ephemeral_5m_input_tokens') or 0; w1 = cc.get('ephemeral_1h_input_tokens') or 0
            else:
                w5 = u.get('cache_creation_input_tokens') or 0; w1 = 0; split_missing = True
            vals = dict(zip(COMP, (u.get('input_tokens') or 0, w5, w1, u.get('cache_read_input_tokens') or 0, u.get('output_tokens') or 0)))
            for k, v in vals.items():
                comp[model][k] += v
                (lead_comp if f == files[0] else work_comp)[model][k] += v
            wmodel = model
        if f != files[0]:
            workers.append({'file': os.path.basename(f), 'model': wmodel, **wtot})
    led = {}
    led_cost = {}
    for model, v in (ledger or {}).items():
        led_cost[model] = v.get('costUSD') or 0
        led[model] = {'input_tokens': v.get('inputTokens') or 0,
                      'cache_creation_input_tokens': v.get('cacheCreationInputTokens') or 0,
                      'cache_read_input_tokens': v.get('cacheReadInputTokens') or 0,
                      'output_tokens': v.get('outputTokens') or 0}
    return {'by_model': by_model, 'lead': lead_tot, 'workers': workers, 'ledger': led, 'unfinished': unfinished,
            'comp': comp, 'lead_comp': lead_comp, 'work_comp': work_comp, 'led_cost': led_cost, 'split_missing': split_missing}


def tin(t):
    return t['input_tokens'] + t['cache_creation_input_tokens'] + t['cache_read_input_tokens']


def price(model, c):
    p = PRICES.get(model)
    if p is None:
        return None
    return {k: c[k] * p[k] / 1e6 for k in COMP}


def cost_of(compmap, warn=None):
    # returns (total or None, per-model dollars dict)
    tot = 0.0; per = {}
    for model, c in compmap.items():
        r = price(model, c)
        if r is None:
            if warn is not None and model not in warn:
                warn.add(model)
                print(f"    WARNING: no price for model {model}; its cost is null")
            per[model] = None
            tot = None
        else:
            per[model] = r
            if tot is not None:
                tot += sum(r.values())
    return tot, per


def fmt(x):
    return 'n/a' if x is None else f"${x:.2f}"


def med(v):
    v = [x for x in v if x is not None]
    return statistics.median(v) if v else None


def rng(v):
    v = [x for x in v if x is not None]
    return [min(v), max(v)] if v else None


out = {}
origin = {}
run_dirs = []
for folder, rx in ARGS:
    for d in sorted(glob.glob(os.path.join(folder, 'runs', '*'))):
        name = os.path.basename(d)
        if rx and not rx.search(name):
            continue
        run_dirs.append((folder, d))
run_dirs.sort(key=lambda x: os.path.basename(x[1]))
for folder, d in run_dirs:
    name = os.path.basename(d)
    try:
        sid = open(os.path.join(d, 'session_id')).read().strip()
        secs = int(open(os.path.join(d, 'seconds')).read())
    except (OSError, ValueError):
        continue
    u = usage(sid)
    if not u:
        continue
    if name in origin:
        sys.exit(f"error: run {name} appears in both {origin[name]} and {folder}")
    origin[name] = folder
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
    warned = set()
    total, per = cost_of(u['comp'], warned)
    lead_c, _ = cost_of(u['lead_comp'])
    work_c, _ = cost_of(u['work_comp'])
    led_total = sum(u['led_cost'].values()) if u['led_cost'] else None
    print(f"    cost {fmt(total)} (lead {fmt(lead_c)}, workers {fmt(work_c)}) | ledger {fmt(led_total)}"
          + (" | split_missing" if u['split_missing'] else ''))
    for model in sorted(per):
        r = per[model]
        if r is None:
            print(f"      {model:22} cost null (no price)")
        else:
            print(f"      {model:22} " + ', '.join(f"{k} ${r[k]:.2f}" for k in COMP) + f" = ${sum(r.values()):.2f}")
    diff = None
    if total is not None and led_total:
        diff = (total - led_total) / led_total * 100
        if abs(diff) > 1:
            print(f"    WARNING: computed cost differs from ledger by {diff:+.2f}%")
    elif total is not None and not led_total:
        print("    WARNING: no ledger in lead transcript")
    out[name]['cost'] = {
        'total': total, 'lead': lead_c, 'workers': work_c, 'split_missing': u['split_missing'],
        'by_model': {m: (None if r is None else {**r, 'total': sum(r.values())}) for m, r in per.items()},
        'ledger': {'total': led_total, 'by_model': u['led_cost']}, 'diff_pct': diff, 'folder': folder}
    out[name]['_opus'] = sum(sum(r.values()) for m, r in per.items() if r is not None and 'opus' in m)
    out[name]['_tin'] = tot_in

cells = defaultdict(list)
for name, r in out.items():
    cells[re.sub(r'-\d+$', '', name)].append(r)
table = {}
print()
print(f"{'cell':12} {'n':>2}  {'total cost med (range)':26} {'Opus cost med (range)':26} total input med (range)")
for c in sorted(cells):
    rs = cells[c]
    tc = [r['cost']['total'] for r in rs]; oc = [r['_opus'] for r in rs]; ti = [r['_tin'] for r in rs]
    table[c] = {'n': len(rs), 'total_cost': {'median': med(tc), 'range': rng(tc)},
                'opus_cost': {'median': med(oc), 'range': rng(oc)},
                'total_input': {'median': med(ti), 'range': rng(ti)}}
    t = table[c]
    def span(k, f):
        m, g = t[k]['median'], t[k]['range']
        return 'n/a' if m is None else f"{f(m)} ({f(g[0])}-{f(g[1])})"
    print(f"{c:12} {t['n']:>2}  {span('total_cost', fmt):26} {span('opus_cost', fmt):26} {span('total_input', lambda x: f'{x/1e6:.2f}M')}")
comps = {}
print()
for c in sorted(table):
    if not c.endswith('-off') or c[:-4] + '-on' not in table:
        continue
    task = c[:-4]; a = table[c]; b = table[task + '-on']
    row = {}
    parts = []
    for key, label in (('total_cost', 'total cost'), ('opus_cost', 'Opus cost')):
        x, y = a[key]['median'], b[key]['median']
        if x is None or y is None or not x:
            row[key] = None; parts.append(f"{label} n/a"); continue
        row[key] = {'off': x, 'on': y, 'pct': (y - x) / x * 100, 'usd': y - x}
        parts.append(f"{label} {row[key]['pct']:+.0f}% ({y - x:+.2f} $)")
    comps[task] = row
    print(f"{task}: on vs off, median " + ', '.join(parts))
for r in out.values():
    del r['_opus'], r['_tin']
out['summary'] = {'cells': table, 'comparisons': comps}
json.dump(out, open(os.path.join(B, 'results.json'), 'w'), indent=1)
