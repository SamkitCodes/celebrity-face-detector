import { useState } from "react";
import { confirmSignUp, resendCode, signIn, signUp } from "../auth.js";

export default function AuthPanel({ onSignedIn }) {
  const [mode, setMode] = useState("signin"); // signin | signup | confirm
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function run(action) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      if (err.code === "UserNotConfirmedException") {
        setMode("confirm");
        setMessage({ kind: "info", text: "Enter the code we emailed you to finish signing up." });
      } else {
        setMessage({ kind: "error", text: err.message || "Something went wrong." });
      }
    } finally {
      setBusy(false);
    }
  }

  const submit = (e) => {
    e.preventDefault();
    if (mode === "signin") run(async () => onSignedIn(await signIn(email, password)));
    if (mode === "signup") run(async () => {
      await signUp(email, password);
      setMode("confirm");
      setMessage({ kind: "info", text: "Check your email for a verification code." });
    });
    if (mode === "confirm") run(async () => {
      await confirmSignUp(email, code);
      onSignedIn(await signIn(email, password));
    });
  };

  return (
    <section className="card auth">
      <h2>{{ signin: "Sign in", signup: "Create an account", confirm: "Verify your email" }[mode]}</h2>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== "confirm" || !password ? (
          <label>
            Password
            <input type="password" required minLength={12}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            {mode === "signup" && <small className="muted">12+ characters with upper, lower case and a number.</small>}
          </label>
        ) : null}
        {mode === "confirm" && (
          <label>
            Verification code
            <input inputMode="numeric" autoComplete="one-time-code" required value={code}
              onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {message && <p className={`notice ${message.kind}`} role="status">{message.text}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Please wait…" : { signin: "Sign in", signup: "Sign up", confirm: "Verify" }[mode]}
        </button>
      </form>
      <p className="switch muted">
        {mode === "signin" && <>New here? <button className="link" onClick={() => setMode("signup")}>Create an account</button></>}
        {mode === "signup" && <>Have an account? <button className="link" onClick={() => setMode("signin")}>Sign in</button></>}
        {mode === "confirm" && <>No code? <button className="link" disabled={!email}
          onClick={() => run(async () => { await resendCode(email); setMessage({ kind: "info", text: "Code re-sent." }); })}>Resend it</button></>}
      </p>
    </section>
  );
}
