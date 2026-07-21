# aih-collab: borrow missing capabilities via the local aih gateway

You run behind the aih multi-provider gateway. If YOU cannot see images or
generate images, another model behind the gateway can — borrow it instead of
refusing. Env: `$AIH_GATEWAY_BASE_URL`, `$AIH_GATEWAY_API_KEY`.

- Discover models: `curl -s -H "Authorization: Bearer $AIH_GATEWAY_API_KEY" "$AIH_GATEWAY_BASE_URL/v1/models?capability=vision"` (image understanding) or `?capability=image_out` (image generation); use the first `data[*].id`.
- Understand an image: POST `$AIH_GATEWAY_BASE_URL/v1/chat/completions` with `{"model":"<vision model>","messages":[{"role":"user","content":[{"type":"text","text":"Describe this image in detail, include all visible text verbatim."},{"type":"image_url","image_url":{"url":"data:image/png;base64,<base64 of file>"}}]}]}`; use the returned description as ground truth and continue the task.
- Generate an image: POST the same endpoint with `{"model":"<image_out model>","messages":[{"role":"user","content":"<drawing prompt>"}]}`; the reply content embeds `data:image/...;base64,...` — decode it to a file (python3: `base64.b64decode`) and give the file to the user.
- **Stripped-image placeholder**: if a message contains `[aih: an image ... is available at $AIH_GATEWAY_BASE_URL/v1/blobs/<id> ...]`, the gateway removed an image you cannot see. Spawn a vision-capable subagent (pin it to a vision model via the Task tool's `model` override or `CLAUDE_CODE_SUBAGENT_MODEL`); have it `curl` that URL (send header `Authorization: Bearer $AIH_GATEWAY_API_KEY`) to a temp file, view/describe it, and return the description. Treat that as ground truth. The `<id>` is content-stable — reuse a prior description for the same id instead of re-fetching.
- Keep images ≤ 4MB. One borrow per need. If the gateway is unreachable or no
  capable model exists, say so honestly; never fabricate image contents.
