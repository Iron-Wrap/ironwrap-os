from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
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
CONTRACT_URI = (
    Path(__file__).resolve().parents[3]
    / "mcp"
    / "erpnext-roofing-mcp"
    / "src"
    / "approval-contract.mjs"
).as_uri()
SERVER_URI = (
    Path(__file__).resolve().parents[3]
    / "mcp"
    / "erpnext-roofing-mcp"
    / "src"
    / "server.mjs"
).as_uri()


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

    def node_receipt(self, args: dict[str, str], *, allow_insecure_local: bool = False) -> str:
        private_key = self.private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("utf-8")
        source = f"""
import fs from "node:fs";
import {{ approvedArgs, digest, signApprovalReceipt }} from {json.dumps(CONTRACT_URI)};
import {{ normalizeFrappeBaseUrl }} from {json.dumps(SERVER_URI)};
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const receipt = signApprovalReceipt(input.private_key, {{
  write_tool: "request_publish_proposal_evidence_pack",
  dry_run_receipt: input.dry_run_receipt,
  agent_role: "owner-operator",
  actor_user: "owner@example.com",
  site_id: digest({{ frappe_base_url: normalizeFrappeBaseUrl(input.mcp_base_url, input.allow_insecure_local === true) }}),
  run_id: input.args.run_id,
  approved_by: input.args.approved_by,
  args_digest: digest(approvedArgs(input.args)),
  issued_at: input.issued_at,
  expires_at: input.expires_at,
}});
process.stdout.write(JSON.stringify({{ receipt }}));
"""
        process = subprocess.run(
            ["node", "--input-type=module", "--eval", source],
            input=json.dumps(
                {
                    "private_key": private_key,
                    "args": args,
                    "dry_run_receipt": self.run["dry_run_receipt"],
                    "mcp_base_url": self.site_base_url,
                    "allow_insecure_local": allow_insecure_local,
                    "issued_at": (self.now - timedelta(seconds=5))
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "expires_at": (self.now + timedelta(minutes=5))
                    .isoformat()
                    .replace("+00:00", "Z"),
                }
            ),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout)["receipt"]

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

    def test_accepts_the_node_issued_receipt_and_its_canonical_argument_digest(self) -> None:
        self.site_base_url = "https://OS.IronWrap.Example/"
        args = {**self.args, "request_text": "Publish the reviewed résumé evidence pack."}
        self.run["approval_receipt"] = self.node_receipt(args)

        self.assert_receipt(args=args)

    def test_accepts_explicit_http_local_development_only(self) -> None:
        self.site_base_url = "http://LOCALHOST:80/"
        args = {**self.args, "request_text": "Publish the local reviewed proposal evidence pack."}
        self.run["approval_receipt"] = self.node_receipt(args, allow_insecure_local=True)

        self.assert_receipt(args=args, allow_insecure_local=True)
        with self.assertRaisesRegex(self.module.ApprovalReceiptError, "site_base_url_invalid"):
            self.assert_receipt(args=args)

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
