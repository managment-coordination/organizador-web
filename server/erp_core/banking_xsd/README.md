# Fixed ISO 20022 schemas

Unmodified XML schemas retrieved on 2026-09-11 from the ISO 20022 public message repository:

- `pain.008.001.08.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/pain/schemas/pain.008.001.08.xsd
  SHA-256 `7edf4e4ce34c47a5567af6a327e22af4ed4007f715822af9f353c94ecc10f5ba`
- `pain.002.001.10.xsd`: https://www.iso20022.org/sites/default/files/documents/messages/pain/schemas/pain.002.001.10.xsd
  SHA-256 `2f9f8d0e9891fa9f31ccf0576397afe501614384d688ae6e43ba694b3d24b0cf`

These are ISO schemas, not EPC Technical Validation Subset (TVS) namespaces.
Schema validation is supplemented by application/profile checks and does not certify bank acceptance.
The original XML bytes are retained. Runtime must verify checksums and must not fetch schemas over the network.
