# Fixed ISO 20022 schemas

Unmodified XML schemas retrieved on 2026-09-11 from the ISO 20022 public message repository:

- `pain.008.001.08.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/pain/schemas/pain.008.001.08.xsd
  SHA-256 `7edf4e4ce34c47a5567af6a327e22af4ed4007f715822af9f353c94ecc10f5ba`
- `pain.002.001.10.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/pain/schemas/pain.002.001.10.xsd
  SHA-256 `2f9f8d0e9891fa9f31ccf0576397afe501614384d688ae6e43ba694b3d24b0cf`

These are ISO schemas, not EPC Technical Validation Subset (TVS) namespaces.
Schema validation is supplemented by application/profile checks and does not certify bank acceptance.
The original XML bytes are retained. Runtime must verify checksums and must not fetch schemas over the network.

ERP 5 statement profiles, retrieved unmodified on 2026-09-14 from the same official repository:

- `camt.053.001.08.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/camt/schemas/camt.053.001.08.xsd
  SHA-256 `338e9cb0c9989b5181802a7b773eece070d6815fc9d6483ac0579117bc24ccba`
- `camt.054.001.08.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/camt/schemas/camt.054.001.08.xsd
  SHA-256 `13d220337d47e22cf25788807c136794a76955791df612c6947277272d440da6`

Schema checks supplement exact amounts, account/block, coverage and aggregate/detail
checks in `reconciliation_adapters.py`. They do not certify a PSP's commercial profile.
