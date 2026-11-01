# Windows-native USN integration tests

The V2 Ingestion suite runs a real Windows USN authority service, not a mocked proof provider. It needs Windows and an authorized, SID-restricted service capable of serving the native protocol.

Default: the test client uses the normal IntentChordUsnAuthority.v1 pipe. For authorized isolated tests against an independently installed/started native authority, set INTENTCHORD_TEST_USN_PIPE to the separate pipe name before running npx vitest run src/core/workspace-index/ingestion/engine-v2-adapter.test.ts --maxWorkers=1.

The test module may substitute only the pipe name for this one module. The underlying authenticated real client, proof checks, fail-closed behavior, and production runtime source remain unchanged. Never redirect to the original service unless intentionally performing a baseline test. Do not include privileged service binaries, local credentials, UAC scripts, or machine-specific test logs in the repository.

The minimal synthetic input fixture is src/test/fixtures/workspace-index-v2-local-source/README.txt.
Test results depend on machine-native USN support and source volume; the full suite is not automatically portable to Linux or macOS. CI running without a Windows native authority should not claim this suite has been executed.
