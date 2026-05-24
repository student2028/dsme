import type { JsonObject } from '../types/common';
import { toolArgNumber, toolArgString } from '../types/agent-messages';

/** Human-readable tool argument summary for chat stream status lines. */
export function formatToolArgs(name: string, args: JsonObject): string {
  try {
    switch (name) {
      case 'web_search':
        return toolArgString(args, 'query') ? ` \`${toolArgString(args, 'query')}\`` : '';
      case 'fetch_url': {
        const url = toolArgString(args, 'url');
        return url ? ` \`${url.slice(0, 80)}${url.length > 80 ? '...' : ''}\`` : '';
      }
      case 'run_command': {
        const command = toolArgString(args, 'command');
        return command ? ` \`${command.slice(0, 60)}${command.length > 60 ? '...' : ''}\`` : '';
      }
      case 'read_file':
        return toolArgString(args, 'filepath') ? ` \`${toolArgString(args, 'filepath')}\`` : '';
      case 'write_file':
        return toolArgString(args, 'filepath') ? ` → \`${toolArgString(args, 'filepath')}\`` : '';
      case 'replace_in_file':
        return toolArgString(args, 'filepath') ? ` \`${toolArgString(args, 'filepath')}\`` : '';
      case 'list_directory':
        return toolArgString(args, 'dirpath') ? ` \`${toolArgString(args, 'dirpath')}\`` : '';
      case 'search_codebase': {
        const query = toolArgString(args, 'query');
        return query ? ` \`${query.slice(0, 40)}${query.length > 40 ? '...' : ''}\`` : '';
      }
      case 'browse_page': {
        const url = toolArgString(args, 'url');
        return url ? ` \`${url.slice(0, 60)}${url.length > 60 ? '...' : ''}\`` : '';
      }
      case 'browser_navigate': {
        const url = toolArgString(args, 'url');
        return url ? ` → \`${url.slice(0, 60)}\`` : '';
      }
      case 'browser_snapshot':
        return ' 📸';
      case 'browser_click':
        return toolArgString(args, 'ref') ? ` [${toolArgString(args, 'ref')}]` : '';
      case 'browser_hover':
        return toolArgString(args, 'ref') ? ` 👆 [${toolArgString(args, 'ref')}]` : '';
      case 'browser_type':
        return toolArgString(args, 'ref')
          ? ` [${toolArgString(args, 'ref')}] "${toolArgString(args, 'text').slice(0, 20)}"`
          : '';
      case 'browser_scroll':
        return toolArgString(args, 'direction') ? ` ${toolArgString(args, 'direction')}` : '';
      case 'browser_back':
        return ' ←';
      case 'browser_eval': {
        const script = toolArgString(args, 'script');
        return script ? ` \`${script.slice(0, 40)}...\`` : '';
      }
      case 'browser_press_key':
        return toolArgString(args, 'key') ? ` ⌨️ ${toolArgString(args, 'key')}` : '';
      case 'browser_list_frames':
        return ' 🖼️';
      case 'browser_switch_frame':
        return args.frameIndex !== undefined ? ` → frame[${String(args.frameIndex)}]` : '';
      case 'browser_task_start': {
        const goal = toolArgString(args, 'goal');
        return goal ? ` — ${goal.slice(0, 80)}${goal.length > 80 ? '…' : ''}` : '';
      }
      case 'browser_task_finish': {
        const summary = toolArgString(args, 'summary');
        return summary ? ` — ${summary.slice(0, 240)}${summary.length > 240 ? '…' : ''}` : '';
      }
      case 'browser_find':
        return toolArgString(args, 'text') ? ` 🔍 "${toolArgString(args, 'text')}"` : '';
      case 'browser_stop_find':
        return ' 🔍 clear';
      case 'browser_export_cookies':
        return ' 🍪 export';
      case 'browser_import_cookies':
        return toolArgString(args, 'file_path')
          ? ` 🍪 import ${toolArgString(args, 'file_path')}`
          : ' 🍪 import';
      case 'browser_clear_session':
        return ' 🧹';
      case 'browser_zoom': {
        const factor = toolArgNumber(args, 'factor');
        return factor !== undefined ? ` 🔎 ${Math.round(factor * 100)}%` : '';
      }
      case 'browser_export_pdf':
        return ' 📄 PDF';
      case 'browser_read_clipboard':
        return ' 📋 read';
      case 'browser_write_clipboard':
        return ' 📋 write';
      case 'browser_page_health':
        return ' 🩺';
      case 'browser_show_overlay':
        return ' 🔵 X-ray';
      case 'browser_clear_overlay':
        return ' clear';
      case 'browser_highlight_ref':
        return toolArgString(args, 'ref') ? ` 🟠 [${toolArgString(args, 'ref')}]` : '';
      case 'browser_upload_file':
        return toolArgString(args, 'ref') ? ` 📁 [${toolArgString(args, 'ref')}]` : '';
      case 'browser_capture_network':
        return toolArgString(args, 'url_pattern') ? ` 🌐 "${toolArgString(args, 'url_pattern')}"` : '';
      case 'browser_list_network_requests':
        return ' 🌐 list API calls';
      case 'browser_get_network_response':
        return toolArgString(args, 'request_id')
          ? ` 🌐 API res: ${toolArgString(args, 'request_id')}`
          : '';
      case 'browser_snapshot_state':
        return ' 📸 Snapshot State';
      case 'browser_restore_state':
        return toolArgString(args, 'state_id')
          ? ` ⏪ Restore: ${toolArgString(args, 'state_id')}`
          : '';
      case 'browser_list_downloads':
        return ' ⬇️ List Downloads';
      default:
        return '';
    }
  } catch {
    return '';
  }
}
