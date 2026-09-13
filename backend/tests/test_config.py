import pytest

from backend import config


@pytest.fixture
def tmp_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_app_dir_created(tmp_appdata):
    d = config.app_dir()
    assert d.exists()
    assert d.name == "作业日程"
    assert str(tmp_appdata) in str(d)


def test_paths_under_app_dir(tmp_appdata):
    assert config.db_path().parent == config.app_dir()
    assert config.credentials_path().parent == config.app_dir()
    assert config.config_path().parent == config.app_dir()


def test_load_config_defaults_when_missing(tmp_appdata):
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30
    assert cfg["bb_remind_defaults"] == [1440, 120]
    assert cfg["bb_remind_enabled"] is True


def test_save_and_load_roundtrip(tmp_appdata):
    config.save_config({"refresh_interval_min": 5})
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 5
    assert cfg["bb_remind_defaults"] == [1440, 120]


def test_save_config_ignores_unknown_keys(tmp_appdata):
    config.save_config({"hacker": True})
    assert "hacker" not in config.load_config()


def test_load_config_tolerates_corrupted_json(tmp_appdata):
    config.config_path().write_text("{ not valid json", encoding="utf-8")
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30


def test_load_config_tolerates_non_dict_json(tmp_appdata):
    config.config_path().write_text("[1, 2, 3]", encoding="utf-8")
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30


def test_load_config_tolerates_empty_file(tmp_appdata):
    config.config_path().write_text("", encoding="utf-8")
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30


def test_load_config_tolerates_undecodable_file(tmp_appdata):
    config.config_path().write_bytes(b"\xff\xfe\x00bad")
    cfg = config.load_config()
    assert cfg["refresh_interval_min"] == 30


def test_loaded_config_does_not_share_defaults(tmp_appdata):
    cfg = config.load_config()
    cfg["bb_remind_defaults"].append(999)
    assert config.DEFAULT_CONFIG["bb_remind_defaults"] == [1440, 120]


def test_course_hues_roundtrip(tmp_appdata):
    config.update_config({"course_hues": {"数据结构与算法": 120, "线性代数": 300}})
    cfg = config.load_config()
    assert cfg["course_hues"] == {"数据结构与算法": 120, "线性代数": 300}


def test_course_hues_patch_keeps_other_keys(tmp_appdata):
    """色表与其他键并存；后续 patch（设置保存/窗口位置）不得丢失 course_hues。"""
    config.update_config({"course_hues": {"数据结构与算法": 120}})
    config.update_config({"refresh_interval_min": 5})
    config.update_config({"window_pos": [10, 20]})
    cfg = config.load_config()
    assert cfg["course_hues"] == {"数据结构与算法": 120}
    assert cfg["refresh_interval_min"] == 5
    assert cfg["window_pos"] == [10, 20]


def test_course_hues_default_empty_and_not_shared(tmp_appdata):
    cfg = config.load_config()
    assert cfg["course_hues"] == {}
    cfg["course_hues"]["污染"] = 1  # 返回值为深拷贝，不污染 DEFAULT_CONFIG
    assert config.DEFAULT_CONFIG["course_hues"] == {}
