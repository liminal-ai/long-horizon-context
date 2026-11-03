# Rows each compact_boundary installs: from the boundary to the first live response (a msg_ id) or a person's row.
[foreach .[] as $r ({on:false, n:0};
  if $r.subtype == "compact_boundary" then {on:true, n:(.n+1), row:null}
  elif .on and (($r.type=="assistant" and (($r.message.id//"")|startswith("msg_"))) or $r.origin != null or $r.promptSource != null) then {on:false, n:.n, row:null}
  elif .on then {on:true, n:.n, row:$r} else {on:false, n:.n, row:null} end;
  select(.row != null) | {boundary:.n, row:.row})]
| group_by(.boundary) | map({boundary: .[0].boundary, rows: length,
    placeholders: ([.[].row | tostring | select(test("image omitted by LHC: m[0-9]+"))] | length),
    images: ([.[].row.message.content | arrays | .[] | select(.type=="image")] | length),
    thinking: ([.[].row.message.content | arrays | .[] | select(.type=="thinking")] | length)})
