# Mac 端（客户端机器）配置

远端机器上按 `Ctrl+V` 粘贴 Mac 剪贴板里的图片时，需要在 Mac 这一侧准备两样东西：读取剪贴板的本地服务，以及通往每台远端机器的常驻 SSH 反向隧道。本目录给出可直接使用的 launchd 配置和 ssh config 片段，其中的用户名、主机名写成占位符，按替换清单改成实际值即可。

```mermaid
flowchart LR
    A[Mac 剪贴板] --> B["launchd inetd + pngpaste<br>127.0.0.1:7779"]
    B -->|ssh RemoteForward| C["远端机器<br>127.0.0.1:7779"]
    C --> D[pi-ssh-image-clipboard]
    D --> E["/tmp/pi-clipboard-UUID.png"]
    E --> F[Pi 输入框]
```

## 文件

| 文件                                     | 用途                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `launchd/clipserve.plist`      | Mac 端图片服务。launchd 监听 127.0.0.1:7779，端口收到连接时才调起 `pngpaste -` 输出 PNG，空闲时不驻留进程 |
| `launchd/pi-clip-tunnel.plist` | 通往一台远端机器的常驻隧道。每台远端机器各一份，`Label` 与日志路径按机器名区分                            |
| `ssh-config.snippet`                     | `~/.ssh/config` 中对应主机块的 `RemoteForward` 写法，隧道与普通登录共用同一段配置                         |

## 占位符替换清单

| 占位符        | 含义                                                            | 示例      |
| ------------- | --------------------------------------------------------------- | --------- |
| `USERNAME`    | Mac 用户名，用于隧道日志路径，以及可选 Unix socket 监听器的路径 | `kerolt`  |
| `REMOTE_HOST` | `~/.ssh/config` 中的主机别名，同时是 ssh 命令的目标             | `fedora`  |
| `REMOTE_USER` | 远端机器上的登录用户名                                          | `kerolt`  |
| `HOST_TAG`    | 区分多台远端机器的后缀，通常与 `REMOTE_HOST` 取同一个值         | `gpu3090` |

## 配置步骤

### 1. Mac 端安装 pngpaste

```sh
brew install pngpaste
which pngpaste
```

输出在 Apple Silicon 机器上是 `/opt/homebrew/bin/pngpaste`，Intel 机器上是 `/usr/local/bin/pngpaste`。两种情况下都要确认 `clipserve` 的 plist 里 `ProgramArguments` 的第一个字符串与实际路径一致。

### 2. 启动 Mac 端图片服务

把 `launchd/clipserve.plist` 复制到 `~/Library/LaunchAgents/`，然后加载：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/clipserve.plist
```

加载后在 Mac 上按 `cmd+ctrl+shift+4` 截图到剪贴板，验证本地读取：

```sh
nc -w 3 127.0.0.1 7779 > /tmp/clip.png
file /tmp/clip.png
```

正常输出形如 `/tmp/clip.png: PNG image data, ...`。剪贴板里没有图片时，`pngpaste` 会把报错写进 `/tmp/pngpaste-clipserve.err`，socket 上收到的是空数据。

这个服务只启动一次，之后所有远端机器共用同一个 127.0.0.1:7779，不需要为每台远端机器再建一份。修改 plist 之后必须重新加载，launchd 不会自己重读文件：

```sh
launchctl bootout gui/$(id -u)/clipserve
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/clipserve.plist
```

### 3. 配置 ssh config

把 `ssh-config.snippet` 里的主机块追加到 `~/.ssh/config`，替换占位符：

```
Host fedora
	HostName fedora
	User kerolt
	Port 22
	# pi-ssh-image-clipboard:fedora
	RemoteForward 127.0.0.1:7779 127.0.0.1:7779
```

`RemoteForward` 让远端机器的 127.0.0.1:7779 指向 Mac 的 127.0.0.1:7779。远端 ssh 端口不是 22 时，把 `Port` 改成实际端口，例如 gpu3090 那种监听 3333 的机器。

### 4. 为每台远端机器建立常驻隧道

把 `launchd/pi-clip-tunnel.plist` 复制到 `~/Library/LaunchAgents/`，文件名与 `Label` 一起带上机器后缀，例如 `pi-clip-tunnel-xyz.plist` 与 `pi-clip-tunnel-xyz`，并把文件里的 `HOST_TAG` 换成 `xyz`、`REMOTE_HOST` 换成 ssh 主机别名、`USERNAME` 换成 Mac 用户名。然后加载：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pi-clip-tunnel-xyz.plist
launchctl print gui/$(id -u)/pi-clip-tunnel-xyz | head -10
```

`RunAtLoad` 与 `KeepAlive` 已经打开，开机与意外断开后自动重启，`ThrottleInterval` 控制重启间隔为 10 秒。

专职隧道的意义在于：VS Code Remote SSH 和普通 ssh 登录复用的是已经建立的连接，`~/.ssh/config` 里新增的 `RemoteForward` 对它们不会立即生效，而且窗口关掉或连接重置都会让转发消失。由 launchd 维护的独立隧道不受这些影响，远端机器的 127.0.0.1:7779 始终可用。

### 5. 远端机器上的 pi 侧设置

隧道本身与 pi 无关，还需要在每台远端机器上安装扩展并解除内置快捷键的占用：

```sh
pi install git:github.com/kerolt/pi-ssh-image-clipboard
```

在 `~/.pi/agent/keybindings.json` 里把内置的图片粘贴动作置空，它在无图形界面的 Linux 上无法工作，并且会截断按键事件：

```json
{
  "app.clipboard.pasteImage": []
}
```

修改后在已经打开的 pi 会话里执行 `/reload`。

## 验证

Mac 端与远端机器上分别测试一次，剪贴板里先放一张截图：

```sh
# Mac 本地
nc -w 3 127.0.0.1 7779 > /tmp/clip.png && file /tmp/clip.png

# 远端机器
ss -ltn | grep 7779
nc -w 3 127.0.0.1 7779 > /tmp/clip.png && file /tmp/clip.png
```

两边的文件大小和 `md5sum` 应当一致。远端机器的 `nc` 必须能在服务端关闭连接后自己退出，否则命令看起来卡住不返回，`file` 也不会有任何输出。各家发行版自带的实现不同：

- Ubuntu、Debian 使用 OpenBSD 版 netcat，加 `-N` 后收到 EOF 立即关闭连接。
- RHEL、Fedora 使用 Nmap 的 ncat，没有 `-N`，用 `--recv-only` 达到同样效果。
- `-w 3` 两种实现都支持，作为等待超时最省事。

## 排障

| 现象                                                               | 原因与处理                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 远端 `nc 127.0.0.1 7779` 长时间不返回                              | 命令没有在服务端关闭连接后退出，与隧道无关。改用 `-N`（OpenBSD netcat）、`--recv-only`（ncat）或者通用的 `-w 3` 重试。用 `ss -tn \| grep 7779` 可以看到连接停在 `CLOSE-WAIT`，结束该 `nc` 进程即可                                                                                                               |
| 远端提示 `Connection refused`                                      | 远端 127.0.0.1:7779 没有监听，隧道未建立。查 `launchctl print gui/$(id -u)/pi-clip-tunnel-<tag>` 和 `~/Library/Logs/pi-clip-tunnel-<tag>.error.log`，并确认 `ssh -S none -o BatchMode=yes <host> true` 能够免密登录 |
| 提示 `Warning: remote port forwarding failed for listen port 7779` | 远端 7779 已被另一条连接占用。专职隧道与 VS Code 会话都会按配置申请同一个端口，先占用的一方生效，后到的一方打印这条警告，功能不受影响                                                                                         |
| 远端 `nc` 收到空数据，`file` 输出 `empty`                          | Mac 剪贴板里没有图片数据。截图要用 `cmd+ctrl+shift+4` 复制到剪贴板，默认的保存到桌面不会写入剪贴板；`/tmp/pngpaste-clipserve.err` 里会有 `No image data found on the clipboard` 记录                                          |
| pi 里按 `Ctrl+V` 无反应                                            | 内置动作 `app.clipboard.pasteImage` 未解绑，或者扩展未加载。检查 `~/.pi/agent/keybindings.json`，在 pi 里执行 `/reload` 或重新启动                                                                                            |
| 图片粘贴成功但模型报错                                             | 当前模型不支持图片输入。用 `pi --list-models` 查看所需模型在 `images` 一列是否为 `yes`                                                                                                                                        |

## 注意事项

- 回环端口方案适合单人使用的开发机。多人共享的服务器上，其他本地用户可以连接 127.0.0.1:7779 读取 Mac 剪贴板。这种场景建议改用扩展支持的 Unix socket 方案，即 `~/.pi-clip/<client>.sock`，配合 `chmod 700`。
- 扩展保存的 `/tmp/pi-clipboard-*.png` 默认权限是 `0644`。涉及敏感内容时可以让 pi 在收窄的 umask 下运行：

  ```sh
  alias pi='(umask 077 && command pi "$@")'
  ```

- 历史文件可以定期清理：

  ```sh
  find /tmp -maxdepth 1 -user "$USER" -name 'pi-clipboard-*' -mtime +1 -delete
  ```
