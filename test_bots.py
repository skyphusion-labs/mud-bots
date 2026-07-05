import sys
from unittest.mock import MagicMock

sys.modules['openai'] = MagicMock()
sys.modules['websockets'] = MagicMock()
sys.modules['websockets.client'] = MagicMock()

import pytest

from mud_security import redact_command, write_creds_json


def test_redact_command_masks_password():
    assert redact_command("s3cret!", "s3cret!") == "********"
    assert redact_command("look north", "s3cret!") == "look north"
    assert redact_command("setpass foo", "") == "********"


def test_write_creds_json_omits_password(tmp_path):
    out = tmp_path / "creds.json"
    write_creds_json(out, {"username": "u", "password": "p", "character_name": "n"})
    data = out.read_text()
    assert "p" not in data
    assert "username" in data
    assert oct(out.stat().st_mode & 0o777) == oct(0o600)


class MockBotConfig:
    def __init__(self, entries):
        self.__dict__.update(entries)
    def __getattr__(self, name):
        return "" 

def test_bot_initialization():
    """Import and test-instantiate the main MUD bot class layout template."""
    import bot
    
    config_data = {
        "host": "localhost",
        "port": 8787,
        "username": "ci_test_runner",
        "password": "mock_password_string",
        "base_url": "" 
    }
    
    mock_config = MockBotConfig(config_data)
    
    test_bot_instance = bot.MUDBot(mock_config)
    assert test_bot_instance is not None

def test_auxiliary_bots_initialization():
    """Verify standalone automation scripts parse and execute variables cleanly."""
    import onboard
    import mapper
    import tutorial
    import revive
