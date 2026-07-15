---
name: aih-collab
description: Borrow missing model capabilities (image understanding / image generation) from other providers through the local aih gateway. Use when the user shares an image but the current model cannot see images, or when the user asks to draw/generate/edit an image and the current model cannot output images.
---

# aih-collab — cross-provider capability borrowing

You are running inside the aih multi-provider gateway. When YOUR model lacks a
capability, other providers behind the same gateway may have it. Borrow it via
one HTTP call instead of refusing the task.

Gateway address and key are injected as environment variables:

- `$AIH_GATEWAY_BASE_URL` (e.g. `http://127.0.0.1:9527`)
- `$AIH_GATEWAY_API_KEY`

## When to use

1. **Vision**: the user attached/referenced an image file but you cannot see
   images → send the image to a vision-capable model, use its description.
2. **Image generation**: the user asks to draw / generate / edit a picture but
   you cannot output images → ask an image-output model, save the result file.

Do NOT use this for capabilities you already have.

## 1. Discover a capable model

```bash
# vision-capable models (can READ images)
curl -s -H "Authorization: Bearer $AIH_GATEWAY_API_KEY" \
  "$AIH_GATEWAY_BASE_URL/v1/models?capability=vision"

# image-output models (can GENERATE images)
curl -s -H "Authorization: Bearer $AIH_GATEWAY_API_KEY" \
  "$AIH_GATEWAY_BASE_URL/v1/models?capability=image_out"
```

Pick the first `data[*].id`. Prefer `gemini-3.1-flash-image` / `gpt-image-*`
for generation when present.

## 2a. Vision: describe an image for me

```bash
IMG=/absolute/path/to/image.png            # ≤ 4MB; jpg/png/webp
MODEL=<vision model id from step 1>
B64=$(base64 < "$IMG" | tr -d '\n')
python3 - "$MODEL" "$B64" <<'PY' | curl -s "$AIH_GATEWAY_BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $AIH_GATEWAY_API_KEY" \
    -H "Content-Type: application/json" -d @- \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
import json, sys
model, b64 = sys.argv[1], sys.argv[2]
print(json.dumps({
  "model": model,
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Describe this image in detail: layout, all visible text (verbatim), colors, objects, and anything a coding agent would need to reproduce or reason about it."},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}
  ]}]
}))
PY
```

Treat the returned description as ground truth about the image and continue
the user's task with it. Tell the user which model provided the description.

## 2b. Image generation: draw for me

```bash
MODEL=<image_out model id from step 1>
OUT=./generated-image.png
PROMPT="<what the user wants drawn, be specific>"
curl -s "$AIH_GATEWAY_BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $AIH_GATEWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"model":sys.argv[1],"messages":[{"role":"user","content":sys.argv[2]}]}))' "$MODEL" "$PROMPT")" \
  | python3 -c '
import json, sys, base64, re
content = json.load(sys.stdin)["choices"][0]["message"]["content"]
m = re.search(r"data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)", content)
if not m:
    print("NO_IMAGE_IN_RESPONSE:", content[:300]); sys.exit(1)
open(sys.argv[1], "wb").write(base64.b64decode(m.group(2)))
print("saved", sys.argv[1])
' "$OUT"
```

Then hand `$OUT` to the user (mention the generating model). If the response
contains no image data, report the model's text answer honestly.

## Rules

- Keep images under ~4MB; downscale first if needed (`sips -Z 1600` on macOS).
- One borrow per need — do not loop retries against the gateway.
- If `$AIH_GATEWAY_BASE_URL` is unset, the gateway is unreachable, or no model
  matches the capability, say so plainly and continue without the capability.
  Never fabricate image contents or pretend an image was generated.
