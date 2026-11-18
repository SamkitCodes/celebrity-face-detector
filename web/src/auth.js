// Cognito sign-up / sign-in using SRP: the password itself is never sent to the server.
import {
  AuthenticationDetails, CognitoUser, CognitoUserAttribute, CognitoUserPool,
} from "amazon-cognito-identity-js";

const pool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_USER_POOL_ID,
  ClientId: import.meta.env.VITE_CLIENT_ID,
});

const userFor = (email) => new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool });

export function signUp(email, password) {
  return new Promise((resolve, reject) => {
    const attrs = [new CognitoUserAttribute({ Name: "email", Value: email.trim().toLowerCase() })];
    pool.signUp(email.trim().toLowerCase(), password, attrs, null, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

export function confirmSignUp(email, code) {
  return new Promise((resolve, reject) => {
    userFor(email).confirmRegistration(code.trim(), true, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

export function resendCode(email) {
  return new Promise((resolve, reject) => {
    userFor(email).resendConfirmationCode((err, res) => (err ? reject(err) : resolve(res)));
  });
}

export function signIn(email, password) {
  return new Promise((resolve, reject) => {
    const details = new AuthenticationDetails({ Username: email.trim().toLowerCase(), Password: password });
    userFor(email).authenticateUser(details, {
      onSuccess: resolve,
      onFailure: reject,
      newPasswordRequired: () => reject(new Error("A new password is required for this account.")),
    });
  });
}

/** Current session (refreshed automatically), or null if signed out. */
export function currentSession() {
  return new Promise((resolve) => {
    const user = pool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err, session) => resolve(err || !session?.isValid() ? null : session));
  });
}

export async function accessToken() {
  const session = await currentSession();
  if (!session) throw new Error("Signed out");
  return session.getAccessToken().getJwtToken();
}

export function signOut() {
  pool.getCurrentUser()?.signOut();
}
