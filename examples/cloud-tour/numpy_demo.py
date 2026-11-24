import numpy as np

samples = np.array([18.5, 20.0, 21.5, 19.0, 23.0, 22.5])
print(f"NumPy {np.__version__} | mean={samples.mean():.2f}")
print("Fahrenheit:", samples * 1.8 + 32)
