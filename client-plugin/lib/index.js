/**
 * dsh-obsidian-panel — node half。
 *
 * 面板 UI 全部在 lib/client.js（浏览器半边，由 dsh-client-modules 提供，
 * 路径 /plugins/dsh-obsidian-panel/client.js）。宿主半边只做条目锚点：
 * 让 profile 能加载并激活本插件，不注册任何宿主侧服务。
 */
export const name = 'dsh-obsidian-panel'

export function apply() {
  // 无宿主侧服务：面板完全在客户端半边实现
}
