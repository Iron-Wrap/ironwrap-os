from setuptools import find_namespace_packages, setup

setup(
    name="ironwrap_roofing",
    version="0.2.0",
    description="IronWrap OS proprietary roofing DocTypes for plain Frappe",
    author="IronWrap Exteriors",
    author_email="sales@ironwrapexteriors.com",
    license="Proprietary",
    packages=find_namespace_packages(
        include=("ironwrap_roofing", "ironwrap_roofing.*")
    ),
    package_data={"": ["*.css", "*.js", "*.json", "*.txt"]},
    include_package_data=True,
    install_requires=["cryptography>=41"],
    python_requires=">=3.10",
    zip_safe=False,
)
