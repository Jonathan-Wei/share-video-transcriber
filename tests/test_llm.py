import json
import tempfile
import unittest
from pathlib import Path

from server import llm


class LLMConfigTests(unittest.TestCase):
    def test_deepseek_defaults_and_chat_url(self):
        config = llm.resolve_config(
            env={"LLM_PROVIDER": "deepseek", "LLM_API_KEY": "dummy-api-key"},
            config_path=Path("missing.json"),
            require_api_key=True,
        )

        self.assertEqual(config.provider, "deepseek")
        self.assertEqual(config.model, "deepseek-chat")
        self.assertEqual(config.base_url, "https://api.deepseek.com")
        self.assertEqual(llm.chat_completions_url(config), "https://api.deepseek.com/chat/completions")

    def test_aliyun_defaults(self):
        config = llm.resolve_config(
            env={"LLM_PROVIDER": "aliyun", "LLM_API_KEY": "dummy-api-key"},
            config_path=Path("missing.json"),
            require_api_key=True,
        )

        self.assertEqual(config.provider, "aliyun")
        self.assertEqual(config.model, "qwen-plus")
        self.assertEqual(config.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1")

    def test_custom_provider_requires_model_and_base_url(self):
        with self.assertRaises(llm.LLMConfigError) as error:
            llm.resolve_config(
                env={"LLM_PROVIDER": "custom", "LLM_API_KEY": "dummy-api-key"},
                config_path=Path("missing.json"),
                require_api_key=True,
            )

        message = str(error.exception)
        self.assertIn("LLM_MODEL", message)
        self.assertIn("LLM_BASE_URL", message)

    def test_saved_config_merges_with_environment_key_by_field(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "llm-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "provider": "deepseek",
                        "model": "deepseek-reasoner",
                        "api_key": "",
                        "timeout": 30,
                    }
                ),
                encoding="utf-8",
            )

            config = llm.resolve_config(
                env={"LLM_API_KEY": "env-key"},
                config_path=config_path,
                require_api_key=True,
            )

        self.assertEqual(config.source, "saved")
        self.assertEqual(config.model, "deepseek-reasoner")
        self.assertEqual(config.api_key, "env-key")
        self.assertEqual(config.timeout, 30)

    def test_save_config_preserves_existing_api_key_and_masks_response(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "llm-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "provider": "deepseek",
                        "api_key": "dummy-old-secret",
                        "model": "deepseek-chat",
                    }
                ),
                encoding="utf-8",
            )

            response = llm.save_config(
                {
                    "provider": "aliyun",
                    "api_key": "",
                    "model": "",
                    "base_url": "",
                    "timeout": 45,
                },
                config_path=config_path,
                env={},
            )
            saved = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(saved["api_key"], "dummy-old-secret")
        self.assertEqual(saved["provider"], "aliyun")
        self.assertEqual(saved["model"], "qwen-plus")
        self.assertTrue(response["api_key_configured"])
        self.assertEqual(response["api_key_masked"], "dum****cret")
        self.assertNotIn("api_key", response)


class LLMRewriteTests(unittest.TestCase):
    def test_build_rewrite_payload_uses_model_and_prompt(self):
        config = llm.RuntimeLLMConfig(
            provider="deepseek",
            model="deepseek-chat",
            base_url="https://api.deepseek.com",
            api_key="dummy-api-key",
            timeout=60,
            source="env",
        )

        payload = llm.build_rewrite_payload(config, text="原始文案", source="caption", style="social")

        self.assertEqual(payload["model"], "deepseek-chat")
        self.assertEqual(payload["temperature"], 0.7)
        self.assertEqual(payload["max_tokens"], 1200)
        self.assertEqual(payload["messages"][-1]["content"], "原始文案")
        self.assertIn("视频主题", payload["messages"][0]["content"])
        self.assertIn("社媒发布", payload["messages"][0]["content"])

    def test_extract_message_text_from_openai_compatible_response(self):
        text = llm.extract_message_text(
            {
                "choices": [
                    {
                        "message": {
                            "content": "改写后的文本",
                        }
                    }
                ]
            }
        )

        self.assertEqual(text, "改写后的文本")

    def test_rewrite_text_uses_injected_post_callable(self):
        calls = []

        def fake_post(url, *, headers, json, timeout):
            calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})

            class FakeResponse:
                def raise_for_status(self):
                    return None

                def json(self):
                    return {"choices": [{"message": {"content": "新文案"}}]}

            return FakeResponse()

        config = llm.RuntimeLLMConfig(
            provider="deepseek",
            model="deepseek-chat",
            base_url="https://api.deepseek.com",
            api_key="dummy-api-key",
            timeout=12,
            source="env",
        )

        result = llm.rewrite_text(config, text="旧文案", source="caption", style="polished", post=fake_post)

        self.assertEqual(result, "新文案")
        self.assertEqual(calls[0]["url"], "https://api.deepseek.com/chat/completions")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer dummy-api-key")
        self.assertEqual(calls[0]["timeout"], 12)


if __name__ == "__main__":
    unittest.main()
