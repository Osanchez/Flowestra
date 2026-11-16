#!/bin/zsh
# One XL benchmark run: a 3-repo fixture (contract/, service/, client/), one headless session, then the suites.
# usage: BENCH=<output folder> run.sh [--dry] <off|on> <rep>
#   --dry  does everything except `claude -p` (seconds is 0), to try the post-checks on the v1 fixture.
set -u
here=${0:A:h}
dry=0
if [ "${1:-}" = "--dry" ]; then dry=1; shift; fi
cond=$1; rep=$2; name=xl-$cond-$rep
dir=$BENCH/runs/$name; rm -rf $dir; mkdir -p $dir/work
cp -R $here/fixture/* $dir/work/
repos=(contract service client)
for r in $repos; do
  git -C $dir/work/$r init -q
  git -C $dir/work/$r add -A
  git -C $dir/work/$r -c user.name=bench -c user.email=bench@example.invalid commit -q -m v1
done
sid=$(uuidgen | tr A-Z a-z); echo $sid > $dir/session_id
prompt="$(cat $here/prompt.txt)"
# The plugin id below is the author's local install; use the id `claude plugin list` shows for yours.
if [ $cond = off ]; then st='{"enabledPlugins":{"flowestra@local-mods":false}}'
else st='{"enabledPlugins":{"flowestra@local-mods":true},"pluginConfigs":{"flowestra@local-mods":{"options":{"workflow":"full"}}}}'; fi
cd $dir/work
start=$(date +%s)
if [ $dry = 1 ]; then
  echo 0 > $dir/exit_code; : > $dir/result.json; : > $dir/stderr.txt
else
  claude -p "$prompt" --model opus --session-id $sid --settings "$st" --permission-mode bypassPermissions --output-format json < /dev/null > $dir/result.json 2> $dir/stderr.txt
  echo $? > $dir/exit_code
fi
if [ $dry = 1 ]; then echo 0 > $dir/seconds; else echo $(( $(date +%s) - start )) > $dir/seconds; fi

# Post-checks: each repository's own suite, then the hidden acceptance suite.
export PYTHONDONTWRITEBYTECODE=1
: > $dir/posttest.txt
summarise() { # <suite> <output file> <exit code>
  local ran fails
  ran=$(grep -Eo '^Ran [0-9]+ test' $2 | awk '{print $2}' | tail -1)
  fails=$(grep -E '^FAILED \(' $2 | grep -Eo '(failures|errors)=[0-9]+' | cut -d= -f2 | paste -sd+ - | bc)
  echo "$1: ${ran:-0} ran, ${fails:-0} fail, exit $3" >> $dir/posttest.txt
}
for r in $repos; do
  (cd $dir/work/$r && python3 -m unittest discover -s tests > $dir/test-$r.txt 2>&1; echo $? > $dir/.rc)
  summarise $r $dir/test-$r.txt $(cat $dir/.rc)
done
(cd $dir && XL_WORK=$dir/work python3 -m unittest discover -s $here/acceptance > $dir/acceptance.txt 2>&1; echo $? > $dir/.rc)
summarise acceptance $dir/acceptance.txt $(cat $dir/.rc)
rm -f $dir/.rc

: > $dir/diffstat.txt
for r in $repos; do
  echo "$r diff: $(git -C $dir/work/$r diff --stat | tail -1)" >> $dir/diffstat.txt
  echo "$r status: $(git -C $dir/work/$r status --short | wc -l | tr -d ' ')" >> $dir/diffstat.txt
done
