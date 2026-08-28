#!/bin/bash
# build.sh — compile the game's engine (FC's own solver + harness) to wasm.
#
#   bash engine/build.sh
#
# Descends from scripts/fcref/build.sh, which built the same solver as a
# probe-only ORACLE from the fcsim checkout in OLD. This one builds from the
# VENDORED copy under engine/ — the tree that carries the LIFIRIK additions
# (belt tangent speed, the grown harness) — and ships the module the game
# loads. The oracle build stays where it was; while both exist, "game vs
# oracle" is a plumbing gate.
#
# **Never pipe a compiler through `head`.** The first fcref version did, and
# `head` closing the pipe SIGPIPEd clang: three of twenty-three objects
# vanished, --allow-undefined waved the corpses through the link, and the
# module failed at instantiation pointing nowhere near the cause.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/vendor/fcsim"
export PATH="/c/Program Files/LLVM/bin:$PATH"

command -v clang >/dev/null || { echo "clang not found — install LLVM"; exit 1; }
mkdir -p "$OUT"

OBJ="$HERE/obj"
rm -rf "$OBJ"; mkdir -p "$OBJ"
# -O3 -flto over -O2: both were gated bit-exact against the -O2 build (every
# solve, every step, every pose and hit hashed) and LTO is worth ~3% on the
# solve set — it inlines fp_sincos2 into the rotation-matrix setter across the
# TU boundary. LLVM does not reassociate float without -ffast-math, which is
# why this is safe and -ffast-math never will be. Do NOT add
# -mnontrapping-fptoint: it turns the f64->i32 trap in rint into a silent 0.
CC_FLAGS=(-O3 -flto "-I$HERE/include" "-I$HERE/include/libc" "-I$HERE/include/fcsim" --target=wasm32 -nostdlib -Wno-switch -Wno-undefined-internal -c)

fail=0
compile() {   # compile <compiler> <extra flags> <file>
  local cc="$1" f="$3"
  local extra=(); [ -n "$2" ] && read -ra extra <<< "$2"
  local o="$OBJ/$(basename "$(dirname "$f")")_$(basename "$f" | sed 's/\.[a-z]*$//').o"
  if ! "$cc" "${CC_FLAGS[@]}" ${extra[@]+"${extra[@]}"} -o "$o" "$f" 2>"$OBJ/err.txt"; then
    echo "FAILED: $f"; sed -n '1,12p' "$OBJ/err.txt"; fail=1
  fi
}

for f in "$HERE"/src/box2d/*.c "$HERE"/src/fpmath/*.c "$HERE"/src/wasm/*.c "$HERE"/src/fcsim/*.c; do
  [ -e "$f" ] && compile clang "" "$f"
done
for f in "$HERE"/src/box2d/*.cpp "$HERE"/src/fcsim/*.cpp; do
  [ -e "$f" ] && compile clang++ "-fno-rtti -fno-exceptions" "$f"
done
compile clang "" "$HERE/harness.c"
rm -f "$OBJ/err.txt"

[ "$fail" = 0 ] || { echo "compile errors — stopping"; exit 1; }

# **No --allow-undefined**: this module calls nothing outside itself, so an
# undefined symbol means a file did not compile, and the link is the right
# place to find that out.
wasm-ld --no-entry --export-all -o "$OUT/fcsim.wasm" "$OBJ"/*.o || exit 1
echo "built public/vendor/fcsim/fcsim.wasm  ($(stat -c%s "$OUT/fcsim.wasm") bytes, $(ls "$OBJ"/*.o | wc -l) objects)"
