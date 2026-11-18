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

Generate through the dedicated Images endpoint. A model advertised by a remote
API-key account does not require a local account for the model's vendor. Let the
gateway resolve the account from the discovered model; do not force `provider`.

```bash
export MODEL='<image_out model id from step 1>'
export OUT='./generated-image.png'
export PROMPT='<what the user wants drawn, be specific>'
python3 - <<'PYGEN'
import base64, json, os, pathlib, urllib.error, urllib.request

base = os.environ['AIH_GATEWAY_BASE_URL'].rstrip('/')
request = urllib.request.Request(
    base + '/v1/images/generations',
    data=json.dumps({
        'model': os.environ['MODEL'],
        'prompt': os.environ['PROMPT'],
        'n': 1,
        'response_format': 'b64_json',
    }).encode(),
    headers={
        'Authorization': 'Bearer ' + os.environ['AIH_GATEWAY_API_KEY'],
        'Content-Type': 'application/json',
    },
    method='POST',
)
try:
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    try:
        detail = json.load(error).get('error', {})
    except (ValueError, AttributeError):
        detail = {}
    if not isinstance(detail, dict):
        detail = {}
    raise SystemExit('IMAGE_GENERATION_FAILED: HTTP %s %s %s' % (
        error.code, detail.get('code', ''), detail.get('message', '')[:300]))
images = result.get('data', [])
encoded = images[0].get('b64_json') if images and isinstance(images[0], dict) else None
if not isinstance(encoded, str) or not encoded:
    raise SystemExit('NO_IMAGE_IN_RESPONSE: expected data[0].b64_json')
image = base64.b64decode(encoded, validate=True)
output = pathlib.Path(os.environ['OUT'])
if image.startswith(b'\x89PNG\r\n\x1a\n'):
    suffix = '.png'
elif image.startswith(b'\xff\xd8\xff'):
    suffix = '.jpg'
elif image.startswith(b'RIFF') and image[8:12] == b'WEBP':
    suffix = '.webp'
else:
    raise SystemExit('INVALID_IMAGE_OUTPUT: unsupported image signature')
output = output.with_suffix(suffix)
output.write_bytes(image)
print('saved', output)
PYGEN
```

Then give the saved file to the user and name the generating model. A text-only
chat completion is not a generated image. Preserve the gateway's error when a
request fails; do not retry by switching to a local vendor account.

## Rules

- Keep images under ~4MB; downscale first if needed (`sips -Z 1600` on macOS).
- One borrow per need — do not loop retries against the gateway.
- If `$AIH_GATEWAY_BASE_URL` is unset, the gateway is unreachable, or no model
  matches the capability, say so plainly and continue without the capability.
  Never invent image contents or pretend an image was generated.
