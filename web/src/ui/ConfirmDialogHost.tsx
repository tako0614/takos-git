import { type JSX } from "solid-js";
import {
  useConfirmDialogActions,
  useConfirmDialogState,
} from "../store/confirm.ts";
import { Dialog } from "./Dialog.tsx";
import { Button } from "./Button.tsx";

/**
 * Renders + resolves the confirm-dialog singleton. Mount once in AppShell; then
 * any view can `await useConfirmDialog().confirm({ title, message, danger })`.
 */
export function ConfirmDialogHost(): JSX.Element {
  const state = useConfirmDialogState();
  const { handleConfirm, handleCancel } = useConfirmDialogActions();
  return (
    <Dialog
      open={state().isOpen}
      onClose={handleCancel}
      size="sm"
      title={state().title}
      footer={
        <>
          <Button variant="default" onClick={handleCancel}>
            {state().cancelText ?? "Cancel"}
          </Button>
          <Button
            variant={state().danger ? "danger" : "primary"}
            onClick={handleConfirm}
          >
            {state().confirmText ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p class="text-sm text-muted">{state().message}</p>
    </Dialog>
  );
}
