you put your testing images here and verify some cases:

- [ ] close the eyes
- [ ] tilt the face
- [ ] before-prepared image portrait photo
- [ ] far/close distance
- [ ] no face detected

## ⚠️ Only `plain-avatar.jpg` passes the liveness gate

The anti-spoofing model (`MiniFASNetV2`) rejects **every large `.png` in this folder**, because they
are screen captures — and a photo of a screen is exactly the presentation attack the model exists to
catch. Measured verdicts:

| Fixture | Verdict | Score |
| :-- | :-- | :-- |
| `plain-avatar.jpg` | **REAL** | 1.00 |
| `good.png` | FAKE | 0.75 |
| `tilt.png` | FAKE | 0.66 |
| `so-far.png` | FAKE | 0.93 |
| `fake-face.png` | FAKE | 0.99 (correct — it is meant to be a spoof) |

The `good` in `good.png` refers to framing (pose, distance, both eyes open), not liveness. It is a
valid fixture for the MediaPipe stage and a guaranteed failure at the anti-spoof stage.

**Any happy-path test must use `plain-avatar.jpg`.** A rejected fixture makes a working pipeline look
broken: the job completes with `status=FAILED` and `Spoofing detected. Please use a real face.`,
which reads like an infrastructure error but is the model doing its job.

To re-measure after adding a fixture:

```bash
docker cp test/ai-test/test-images/input/<file> helpme-ai-server:/tmp/<file>
docker exec helpme-ai-server python -c "
from anti_spoofing.anti_fake import test
print(test('/tmp/<file>', '/app/anti_spoofing/resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth', device_id=-1))
"   # 1 = real, anything else = rejected
```
