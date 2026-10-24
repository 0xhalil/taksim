import SwiftUI
import TaksimKit

/// A turn that failed because the agent's login is signed out (a new computer, a sign-in that expired): the one
/// action signs that login in right here, its CLI's own sign-in in a terminal under it, then sends the request again.
struct ChatSignIn: View {
    let backend: String
    let store: CanvasStore
    let agent: Agent?
    let retry: () -> Void
    @State private var accounts: AccountsModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let signing = accounts?.login != nil || accounts?.installing.contains(backend) == true
            Button { Task { await signIn() } } label: {
                HStack(spacing: 7) {
                    if signing { ProgressView().controlSize(.mini) } else { BackendTile(backend: backend, size: 16) }
                    Text(signing ? L("Signing in") : L("Sign in"))
                }
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(JB.accentInk)
                .padding(.horizontal, 12).frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 6).fill(JB.accent))
                .opacity(signing ? 0.6 : 1)
            }
            .buttonStyle(Press())
            .pointerStyle(.link)
            .disabled(signing)
            if let l = accounts?.login {
                LoginTerminal(login: l, cancel: { accounts?.cancel() })
                    .frame(maxWidth: 520)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: accounts?.login == nil)
        .onDisappear { accounts?.cancel() }
    }

    private func signIn() async {
        let a = accounts ?? AccountsModel(api: store.api)
        accounts = a
        if a.backends.isEmpty { await a.load() }
        // its own account when it has one for this CLI, else this computer's login
        let own = agent?.account.flatMap { id in a.accounts.first { $0.id == id && $0.backend == backend } }
        if let own {
            if a.backends.first(where: { $0.name == backend })?.installed != true, !(await a.install(backend)) { return }
            await a.signIn(account: own.id, backend: backend)
        } else if let cli = a.backends.first(where: { $0.name == backend }) {
            await a.signIn(cli)
        }
        if await AccountsModel.ready(api: store.api, backend: backend, account: own?.id) == true {
            await store.loadChoices()
            retry()
        }
    }
}
