# Security Policy

## Supported versions

Security fixes are provided for the current public beta release and the current `main` branch of the generated public repository. Older snapshots may not receive fixes.

## Reporting a vulnerability

Do not open a public issue containing an unpatched vulnerability, credential, private key, token, customer information, or sensitive local-path details.

Report vulnerabilities privately through the security-reporting channel published by ProChat for the public repository. Include:

- the affected version or source commit;
- a concise description of the issue and impact;
- reproducible steps using synthetic data;
- affected paths or operations;
- any suggested mitigation;
- whether the issue has been disclosed elsewhere.

ProChat will acknowledge a valid report, investigate it, and coordinate remediation and disclosure. Response times are not guaranteed by this policy.

## Scope

Security reports may cover the public Workbench Local snapshot, including:

- local dashboard and agent;
- Custom GPT action routes and authentication;
- source locking and path containment;
- guarded file, command, Git, packet, and validation operations;
- local relay and proxy components;
- public-export tooling and release validation.

Managed services, private modules, and customer-specific deployments are handled under their separate support or commercial agreements.

## Safe testing

Use only systems and repositories you own or are authorized to test. Do not access other users' data, degrade services, persist access, or publish sensitive findings before a coordinated fix is available.
