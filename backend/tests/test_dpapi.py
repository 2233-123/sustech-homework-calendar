import sys

import pytest

from backend import dpapi

requires_windows = pytest.mark.skipif(sys.platform != "win32", reason="仅 Windows")


@requires_windows
def test_roundtrip():
    data = "20231234:my-password".encode("utf-8")
    blob = dpapi.protect(data)
    assert blob != data
    assert dpapi.unprotect(blob) == data


@requires_windows
def test_tampered_blob_raises():
    blob = bytearray(dpapi.protect(b"secret"))
    blob[len(blob) // 2] ^= 0xFF
    with pytest.raises(OSError):
        dpapi.unprotect(bytes(blob))
