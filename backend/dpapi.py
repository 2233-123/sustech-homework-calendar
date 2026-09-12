"""Windows DPAPI 加解密（ctypes 实现，无需 pywin32）。

加密数据绑定当前 Windows 用户，仅本机同一用户可解密。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes

_CRYPTPROTECT_UI_FORBIDDEN = 0x1
_crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _make_blob(data: bytes):
    """返回 (buffer, blob)。调用方必须持有 buffer 引用直到 API 调用结束。"""
    buf = (
        ctypes.create_string_buffer(data, len(data))
        if data
        else ctypes.create_string_buffer(1)
    )
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return buf, blob


def _take_blob(blob: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        _kernel32.LocalFree(ctypes.cast(blob.pbData, ctypes.c_void_p))


def protect(data: bytes) -> bytes:
    """用当前 Windows 用户凭据加密（DPAPI）。"""
    _buf, in_blob = _make_blob(data)
    out = _DataBlob()
    ok = _crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    )
    if not ok:
        raise OSError(f"CryptProtectData 失败，错误码 {ctypes.get_last_error()}")
    return _take_blob(out)


def unprotect(data: bytes) -> bytes:
    """DPAPI 解密。"""
    _buf, in_blob = _make_blob(data)
    out = _DataBlob()
    ok = _crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    )
    if not ok:
        raise OSError(f"CryptUnprotectData 失败，错误码 {ctypes.get_last_error()}")
    return _take_blob(out)
