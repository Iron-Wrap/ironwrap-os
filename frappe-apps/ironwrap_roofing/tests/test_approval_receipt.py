from __future__ import annotations

import base64
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "ironwrap_roofing" / "approval_receipt.py"
)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


class ApprovalReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "ironwrap_approval_receipt_under_test", MODULE_PATH
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.private_key = Ed25519PrivateKey.generate()
        self.now = datetime(2026, 7, 17, 10, 0, tzinfo=UTC)
        self.site_base_url = "https://os.ironwrap.example"
        self.args = {
            "proposal_evidence_pack_id": "proposal:cq-1",
            "request_text": "Publish the reviewed proposal evidence pack to the private portal.",
            "approved_by": "owner@example.com",
            "run_id": "run-proposal-publication-0001",
        }
        self.run = {
            "run_id": self.args["run_id"],
            "agent_role": "Owner Operator",
            "requested_by": "owner@example.com",
            "approved_by": "owner@example.com",
            "dry_run_receipt": "dry-run-receipt-bound-by-human-approval",
        }

    def receipt(self, **overrides: object) -> str:
        payload = {
            "v": 1,
            "type": "hermes-human-approval",
            "write_tool": "request_publish_proposal_evidence_pack",
            "dry_run_receipt": self.run["dry_run_receipt"],
            "agent_role": "owner-operator",
            "actor_user": self.run["requested_by"],
            "site_id": self.module._digest({"frappe_base_url": self.site_base_url}),
            "run_id": self.run["run_id"],
            "approved_by": self.run["approved_by"],
            "args_digest": self.module._digest(self.args),
            "issued_at": (self.now - timedelta(seconds=5)).isoformat().replace("+00:00", "Z"),
            "expires_at": (self.now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        }
        payload.update(overrides)
        encoded_payload = _base64url(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
                "utf-8"
            )
        )
        signature = self.private_key.sign(encoded_payload.encode("ascii"))
        return f"{encoded_payload}.{_base64url(signature)}"

    def with_public_key(self):
        temp = tempfile.NamedTemporaryFile("wb", delete=False)
        temp.write(
            self.private_key.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        temp.close()
        return temp.name

    def assert_receipt(
        self,
        run: dict | None = None,
        args: dict | None = None,
        *,
        allow_insecure_local: bool = False,
    ) -> None:
        path = self.with_public_key()
        try:
            with patch.dict(
                os.environ,
                {
                    "IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE": path,
                    "IRONWRAP_HERMES_SITE_BASE_URL": self.site_base_url,
                    "IRONWRAP_HERMES_ALLOW_INSECURE_LOCAL": str(allow_insecure_local).lower(),
                },
                clear=False,
            ):
                self.module.assert_approved_hermes_run_receipt(
                    run or self.run,
                    write_tool="request_publish_proposal_evidence_pack",
                    approved_args=args or self.args,
                    now=self.now,
                )
        finally:
            os.unlink(path)

    def test_accepts_a_current_receipt_bound_to_the_locked_run(self) -> None:
        self.run["approval_receipt"] = self.receipt()

        self.assert_receipt()

    def test_binds_the_canonical_site_base_url(self) -> None:
        self.site_base_url = "https://OS.IronWrap.Example/"
        self.run["approval_receipt"] = self.receipt(
            site_id=self.module._digest({"frappe_base_url": "https://os.ironwrap.example"})
        )

        self.assert_receipt()

    def test_accepts_explicit_http_local_development_only(self) -> None:
        self.site_base_url = "http://LOCALHOST:80/"
        self.run["approval_receipt"] = self.receipt(
            site_id=self.module._digest({"frappe_base_url": "http://localhost"})
        )

        self.assert_receipt(allow_insecure_local=True)
        with self.assertRaisesRegex(self.module.ApprovalReceiptError, "site_base_url_invalid"):
            self.assert_receipt()

    def test_rejects_a_mutated_audit_row_even_when_other_fields_look_approved(self) -> None:
        self.run["approval_receipt"] = self.receipt()
        mutated_args = {**self.args, "proposal_evidence_pack_id": "proposal:other"}

        with self.assertRaisesRegex(
            self.module.ApprovalReceiptError, "mismatch_args_digest"
        ):
            self.assert_receipt(args=mutated_args)

    def test_rejects_expired_or_cross_actor_capabilities(self) -> None:
        self.run["approval_receipt"] = self.receipt(
            expires_at=(self.now - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
        )
        with self.assertRaisesRegex(self.module.ApprovalReceiptError, "expired"):
            self.assert_receipt()

        self.run["approval_receipt"] = self.receipt()
        wrong_actor = {**self.run, "requested_by": "other@example.com"}
        with self.assertRaisesRegex(
            self.module.ApprovalReceiptError, "mismatch_actor_user"
        ):
            self.assert_receipt(run=wrong_actor)

        self.run["approval_receipt"] = self.receipt(site_id="b" * 64)
        with self.assertRaisesRegex(
            self.module.ApprovalReceiptError, "mismatch_site_id"
        ):
            self.assert_receipt()

    def test_fails_closed_without_the_app_container_public_key(self) -> None:
        self.run["approval_receipt"] = self.receipt()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(
                self.module.ApprovalReceiptError, "public_key_missing"
            ):
                self.module.assert_approved_hermes_run_receipt(
                    self.run,
                    write_tool="request_publish_proposal_evidence_pack",
                    approved_args=self.args,
                    now=self.now,
                )


if __name__ == "__main__":
    unittest.main()
