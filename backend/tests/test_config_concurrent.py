import threading

import pytest

from backend import config


@pytest.fixture
def tmp_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_update_config_roundtrip(tmp_appdata):
    ret = config.update_config({"window_scale": 150})
    assert ret["window_scale"] == 150
    assert ret["refresh_interval_min"] == 30  # 未 patch 的既有键被保留
    assert config.load_config()["window_scale"] == 150  # 文件确实更新

    ret2 = config.update_config({"window_pos": [10, 20]})
    assert ret2["window_pos"] == [10, 20]
    assert ret2["window_scale"] == 150  # 合并语义：前次更新仍在
    assert config.load_config()["window_pos"] == [10, 20]


def test_concurrent_updates_no_lost_update(tmp_appdata):
    # 预置非默认值，便于识别某类更新被并发写吞掉（回到默认即视为丢失）
    config.save_config({"window_pos": [1, 1], "window_scale": 101})
    n = 40

    def worker(i):
        if i % 2 == 0:
            config.update_config({"window_pos": [i, i]})
        else:
            config.update_config({"window_scale": i})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    cfg = config.load_config()
    # window_pos 的更新未被并发的 window_scale 写覆盖（严格成员断言，可抓「pos 更新全丢」）
    assert cfg["window_pos"] in [[i, i] for i in range(0, n, 2)], cfg
    # window_scale 的更新未被并发的 window_pos 写覆盖
    assert cfg["window_scale"] in range(1, n, 2), cfg
    # 终态两类键均非默认值
    assert cfg["window_pos"] is not None
    assert cfg["window_scale"] != 100
    # 文件仍可正常读回
    assert cfg["refresh_interval_min"] == 30
