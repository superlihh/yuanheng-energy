# Third-party notices

## Apache ECharts 5.6.0

The browser bundle at `frontend/vendor/echarts-5.6.0/echarts.min.js` is the Apache ECharts 5.6.0 distribution file. The corresponding `LICENSE` and `NOTICE` files are retained beside it. The package was obtained from the npm registry URL recorded in `source.json`; the published SHA-512 integrity value and the extracted files' SHA-256 values are recorded there.

Upstream: <https://github.com/apache/echarts/tree/5.6.0>

This project does not load the bundle from a remote CDN. Any future vendored dependency must add its version, source URL, integrity/hash, license, notice, and the exact files included here.

The Python runtime uses NumPy and SciPy from the environment rather than vendoring their source. Their dependency metadata and licenses remain the responsibility of the deployment environment and should be included in a production distribution manifest.

