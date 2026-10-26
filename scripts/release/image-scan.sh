#!/bin/sh
# L2.2 / F12: vulnerability scan of the exact image. Fixable HIGH and CRITICAL findings fail; unfixed ones are
# not reported as failures (nothing can be done about them yet).
# The scanner never gets the Docker socket: the image is exported to a tarball and scanned offline from that file,
# so a compromised scanner cannot retag or replace the image between test and push. The tarball is scanned as
# built; the pushed image is checked to be the same image ID by the caller (docker-publish.yml).
#   scripts/release/image-scan.sh <image-ref>
set -eu
image="${1:?usage: image-scan.sh <image-ref>}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.57.1}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker save "$image" -o "$dir/image.tar"
docker run --rm -v "$dir":/scan:ro "$TRIVY_IMAGE" image --input /scan/image.tar \
  --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress
