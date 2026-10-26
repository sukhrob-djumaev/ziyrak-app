#!/bin/sh
# L2.2 / F12: vulnerability scan of the exact image. Fixable HIGH and CRITICAL findings fail; unfixed ones are
# reported but do not (nothing can be done about them yet). Pinned scanner image, no network access to the app.
#   scripts/release/image-scan.sh <image-ref>
set -eu
image="${1:?usage: image-scan.sh <image-ref>}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.57.1}"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$TRIVY_IMAGE" image \
  --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress "$image"
