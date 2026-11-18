import { readFileSync, existsSync } from "node:fs";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createApp } from "./app.js";
import { createDb, createStorage } from "./aws.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

const region = required("AWS_REGION");
const userPoolId = required("USER_POOL_ID");

const verifier = CognitoJwtVerifier.create({
  userPoolId,
  clientId: required("WEB_CLIENT_ID"),
  tokenUse: "access",
});

// The instance has no internet access, so it cannot download Cognito's public
// signing keys (JWKS). deploy.sh fetches them and ships them in the bundle.
const jwksPath = new URL("../jwks.json", import.meta.url);
if (existsSync(jwksPath)) {
  verifier.cacheJwks(JSON.parse(readFileSync(jwksPath, "utf8")));
} else {
  console.warn("jwks.json not found; verifier will try to fetch JWKS over the network");
}

const app = createApp({
  verifyToken: (token) => verifier.verify(token),
  db: createDb({ region, tableName: required("TABLE_NAME") }),
  storage: createStorage({ region, bucket: required("UPLOADS_BUCKET") }),
  config: { dailyUploadLimit: Number(process.env.DAILY_UPLOAD_LIMIT || 20) },
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(JSON.stringify({ msg: "api listening", port })));
