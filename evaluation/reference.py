"""Independent SciPy Clopper-Pearson references; never imports ReleaseGuard."""
import json
import pathlib
import platform
import scipy
from scipy.stats import binomtest

cases = []
for n in [1, 5, 100, 800, 1600, 3200, 20000]:
    for k in sorted({0, 1, n // 100, n // 2, n - 1, n}):
        for alpha in [0.025, 0.05 / 144, 0.001 / (3 * 4 * 9 * 2 * 2 * 2)]:
            ci = binomtest(k, n).proportion_ci(confidence_level=1 - 2 * alpha, method='exact')
            cases.append(dict(k=k, n=n, tailAlpha=alpha, lower=ci.low, upper=ci.high))
destination = pathlib.Path(__file__).with_name('reference.json')
destination.write_text(json.dumps(dict(method='scipy.stats.binomtest.proportion_ci(method=exact)',
    scipy=scipy.__version__, python=platform.python_version(), cases=cases), indent=2) + '\n', encoding='utf8')
print(f'Wrote {len(cases)} independent reference intervals')
