// Public root-CA certificate for the self-hosted Fly Postgres (leavecast-db).
// Safe to commit: this is a CERTIFICATE, not a private key. It is pinned as the
// trusted CA so clients fully verify the database's identity (equivalent to
// sslmode=verify-full). The server presents a leaf cert signed by this CA.
// NOTE: pass this via the pg `ssl` option and DO NOT put sslmode in the URL —
// node-postgres lets a URL sslmode override the ssl object, breaking the pin.
export const FLY_DB_CA = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUaCW81J3W07r4sRXrWE1q9DyymfwwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPbGVhdmVjYXN0LWRiLWNhMB4XDTI2MTEwMjE1MTQ0N1oX
DTM2MTAzMDE1MTQ0N1owGjEYMBYGA1UEAwwPbGVhdmVjYXN0LWRiLWNhMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyJJLVp8X+TwOo9XCXmaHRy87wQna
JY2jg8yg32X/MghN2M86KiP+jbpQLITEJK+IPDvV0g6VXR5wZQetRl71cR3JOGVE
4O+fGGZwrcbHi/ZMVtI+IHC0N+odfEMVXWw6PDnKAjZa10S7EZRgZIVq1ipUK1bs
ssLlLcNRv7YDuSriuFtzrYMuAiVvtNXa70yEeA87Xzc4JQ2jyDXia27NEXSw/rT0
gkrghr93PlSlnxaJEyEq++ljNxsoo8OQe+G+cnB8mujnaedlc8peapU5sD85CXU1
ZH8f2PLzq+m45+LU9VXvzYwWtQOYQPJ4zVZvxov7LUx2KOaXro+K73MEgQIDAQAB
o1MwUTAdBgNVHQ4EFgQUUb9W2rLK/1HBfVZ7/P+E7vqdq1IwHwYDVR0jBBgwFoAU
Ub9W2rLK/1HBfVZ7/P+E7vqdq1IwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAhFIlcogNutLL9aHHB24RR0QXKwYxtMu3g3tjEtDnqaimlcf+NLxp
2EyafLXwl8Z1N11gkaymjAFePLqFKBhIjEBOy+s8PG8L6ta9asQ8FKnCt5typVk/
E5fv8GUKffVxyFGooPPMOCus+0uxrzzNfH+Hj3jJpu4w/TtlGRNClxaQznLRjNv7
wY4Cc97BYHXrz8LekjBrX9SqlBSU64np7A2gGV3Cv5ggK+Y3is+xHzMB6hrZEUSu
Qhas+0WLI8w535T6gI7JXtE+rBL4cp+pw0d+bIRrHSObJZGsV9mfq4EZF+kga3k0
m2zZ924jPZvT6LcSLkjiEyKwnQpETRtz7Q==
-----END CERTIFICATE-----
`;
