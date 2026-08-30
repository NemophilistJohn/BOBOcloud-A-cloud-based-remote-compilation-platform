export async function activate(context) {
  await context.commands.register(
    'example.hello-plugin.hello',
    () => ({ message: 'Hello from an isolated BOBOCloud plugin.' }),
    {
      title: 'Hello Plugin: Say Hello',
      category: 'Extensions'
    }
  );
}

export async function deactivate() {
  // The host disposes command registrations automatically.
}
