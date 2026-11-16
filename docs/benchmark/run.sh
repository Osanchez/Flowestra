#!/bin/zsh
# One benchmark run: a fresh clone at a fixed commit, one headless session, then the test suite.
# usage: BENCH=<output folder> FLOWESTRA_REPO=<clone url or path> run.sh <small|large> <off|on> <rep>
set -u
here=${0:A:h}
size=$1; cond=$2; rep=$3; name=$size-$cond-$rep
dir=$BENCH/runs/$name; rm -rf $dir; mkdir -p $dir
git clone -q $FLOWESTRA_REPO $dir/flowestra
git -C $dir/flowestra checkout -q 80f31ca
sid=$(uuidgen | tr A-Z a-z); echo $sid > $dir/session_id
prompt="$(cat $here/common.txt $here/$size.txt)"
# The plugin id below is the author's local install; use the id `claude plugin list` shows for yours.
if [ $cond = off ]; then st='{"enabledPlugins":{"flowestra@local-mods":false}}'
else st='{"enabledPlugins":{"flowestra@local-mods":true},"pluginConfigs":{"flowestra@local-mods":{"options":{"workflow":"full"}}}}'; fi
cd $dir/flowestra
start=$(date +%s)
claude -p "$prompt" --model opus --session-id $sid --settings "$st" --permission-mode bypassPermissions --output-format json < /dev/null > $dir/result.json 2> $dir/stderr.txt
echo $? > $dir/exit_code
echo $(( $(date +%s) - start )) > $dir/seconds
claude plugin test $dir/flowestra > $dir/posttest.txt 2>&1; echo $? >> $dir/posttest.txt
git -C $dir/flowestra diff --stat > $dir/diffstat.txt; git -C $dir/flowestra status --short >> $dir/diffstat.txt
