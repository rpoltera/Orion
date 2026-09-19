sub init()
    m.rows = m.top.findNode("rows")
    m.status = m.top.findNode("status")
    m.serverLabel = m.top.findNode("server")
    m.background = m.top.findNode("background")
    m.video = m.top.findNode("video")
    registry = CreateObject("roRegistrySection", "Orion")
    savedBackground = registry.Read("themeBackground")
    if savedBackground <> "" then m.background.color = savedBackground
    m.currentView = "home"
    m.currentSection = ""
    m.currentPage = 0
    m.rows.observeField("rowItemSelected", "onItemSelected")
    m.video.observeField("state", "onVideoState")
    m.top.observeField("serverUrl", "onServerChanged")

    if normalizeServer(m.top.serverUrl) = "" then
        m.status.text = "Press * to connect Orion."
    else
        loadHome()
    end if
    m.rows.setFocus(true)
end sub

sub onServerChanged()
    if normalizeServer(m.top.serverUrl) <> "" then loadHome()
end sub

sub loadHome()
    m.currentView = "home"
    m.currentSection = ""
    m.currentPage = 0
    m.serverLabel.text = "Server: " + normalizeServer(m.top.serverUrl) + "   •   * Settings"
    m.status.text = "Loading Orion..."
    startLoader("home", "", 0, "")
end sub

sub loadBrowse(section as String, page as Integer)
    m.currentView = "browse"
    m.currentSection = section
    m.currentPage = page
    m.status.text = "Loading " + sectionLabel(section) + "..."
    startLoader("browse", section, page, "")
end sub

sub loadEpisodes(showName as String)
    m.currentView = "episodes"
    m.status.text = "Loading " + showName + "..."
    startLoader("episodes", "", 0, showName)
end sub

sub startLoader(mode as String, section as String, page as Integer, showName as String)
    m.loader = CreateObject("roSGNode", "OrionLoadTask")
    m.loader.serverUrl = normalizeServer(m.top.serverUrl)
    m.loader.mode = mode
    m.loader.section = section
    m.loader.page = page
    m.loader.showName = showName
    m.loader.observeField("payload", "onLibraryLoaded")
    m.loader.observeField("error", "onLibraryError")
    m.loader.control = "RUN"
end sub

sub onLibraryLoaded()
    if m.loader = invalid or m.loader.payload = "" then return
    data = ParseJson(m.loader.payload)
    if data = invalid then
        m.status.text = "Orion returned unreadable data."
        return
    end if

    if data.mode = "home" then
        renderHome(data)
    else if data.mode = "episodes" then
        renderEpisodes(data)
    else if data.mode = "browse" then
        renderBrowse(data)
    end if
end sub

sub onLibraryError()
    if m.loader <> invalid and m.loader.error <> "" then m.status.text = m.loader.error
end sub

sub renderHome(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    addNavigationRow(root)
    addMediaRow(root, "Movies • " + countText(data.moviesTotal), data.movies, "video", "movies")
    addMediaRow(root, "TV Shows • " + countText(data.tvShowsTotal), data.tvShows, "show", "tvShows")
    addMediaRow(root, "Music • " + countText(data.musicTotal), data.music, "music", "music")
    addMediaRow(root, "Music Videos • " + countText(data.musicVideosTotal), data.musicVideos, "video", "musicVideos")
    addMediaRow(root, "Live TV (IPTV) • " + countText(data.iptvTotal), data.iptv, "iptv", "iptv")
    addMediaRow(root, "Orion Channels • " + countText(data.channels.Count()), data.channels, "channel", "channels")
    addMediaRow(root, "Themes", data.themes, "theme", "themes")
    m.homeContent = root
    m.rows.content = root
    m.status.text = "Select a title to play • Press * for server settings"
    m.rows.setFocus(true)
end sub

sub renderBrowse(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    section = data.section
    kind = kindForSection(section)
    label = sectionLabel(section) + " • Page " + (data.page + 1).ToStr() + " • " + countText(data.total)
    row = root.createChild("ContentNode")
    row.title = label
    for each item in data.items
        addItem(row, item, kind, section)
    end for
    if (data.page + 1) * data.limit < data.total then addMoreItem(row, section, data.page + 1)
    m.rows.content = root
    m.currentView = "browse"
    m.currentSection = section
    m.currentPage = data.page
    m.status.text = sectionLabel(section) + " • Back returns to Home"
    m.rows.setFocus(true)
end sub

sub renderEpisodes(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = data.title + " • " + countText(data.total) + " Episodes"
    for each item in data.items
        addItem(row, item, "video", "tvShows")
    end for
    m.rows.content = root
    m.currentView = "episodes"
    m.status.text = "Select an episode to play • Back returns to Home"
    m.rows.setFocus(true)
end sub

sub addNavigationRow(root as Object)
    row = root.createChild("ContentNode")
    row.title = "Browse Orion"
    entries = [
        { title: "Movies", section: "movies", color: "1F5EDB" }
        { title: "TV Shows", section: "tvShows", color: "7936B5" }
        { title: "Music", section: "music", color: "B45309" }
        { title: "Music Videos", section: "musicVideos", color: "BD3B72" }
        { title: "Live TV", section: "iptv", color: "0F766E" }
        { title: "Channels", section: "channels", color: "0B68B8" }
        { title: "Themes", section: "themes", color: "6D28D9" }
    ]
    for each entry in entries
        node = createNode(row)
        node.title = entry.title
        node.shortDescriptionLine1 = "Browse all"
        node.orionKind = "section"
        node.section = entry.section
        node.accentColor = entry.color
    end for
end sub

sub addMediaRow(root as Object, label as String, items as Object, kind as String, section as String)
    if items = invalid or items.Count() = 0 then return
    row = root.createChild("ContentNode")
    row.title = label
    for each item in items
        addItem(row, item, kind, section)
    end for
end sub

sub addItem(row as Object, item as Object, kind as String, section as String)
    node = createNode(row)
    node.orionKind = kind
    node.section = section
    node.mediaId = stringValue(item, "id")
    node.title = itemTitle(item, kind)
    node.shortDescriptionLine1 = itemSubtitle(item, kind)
    node.hdPosterUrl = imageUrl(stringValue(item, "thumbnail"))
    if node.hdPosterUrl = "" then node.hdPosterUrl = imageUrl(stringValue(item, "poster"))
    if kind = "show" then node.showName = stringValue(item, "showName")
    if node.showName = "" and kind = "show" then node.showName = node.title
    if kind = "theme" then
        node.accentColor = themeColor(item, "--accent", "6D28D9")
        node.backgroundColor = themeColor(item, "--bg-primary", "080D1A")
    else if kind = "channel" then
        node.accentColor = "0B68B8"
    else if kind = "iptv" then
        node.accentColor = "0F766E"
    end if
end sub

sub addMoreItem(row as Object, section as String, page as Integer)
    node = createNode(row)
    node.title = "Next Page"
    node.shortDescriptionLine1 = "More " + sectionLabel(section)
    node.orionKind = "more"
    node.section = section
    node.page = page
    node.accentColor = "334155"
end sub

function createNode(row as Object) as Object
    node = row.createChild("ContentNode")
    node.addFields({
        orionKind: ""
        mediaId: ""
        showName: ""
        section: ""
        page: 0
        accentColor: ""
        backgroundColor: ""
    })
    return node
end function

sub onItemSelected()
    selected = m.rows.rowItemSelected
    if selected = invalid or selected.Count() <> 2 then return
    row = m.rows.content.getChild(selected[0])
    if row = invalid then return
    item = row.getChild(selected[1])
    if item = invalid then return

    kind = item.orionKind
    if kind = "section" then
        loadBrowse(item.section, 0)
    else if kind = "more" then
        loadBrowse(item.section, item.page)
    else if kind = "show" then
        loadEpisodes(item.showName)
    else if kind = "theme" then
        applyTheme(item)
    else if kind = "music" then
        startPlayback(item, normalizeServer(m.top.serverUrl) + "/api/roku/audio/" + item.mediaId, "mp3")
    else if kind = "iptv" then
        startPlayback(item, normalizeServer(m.top.serverUrl) + "/api/roku/iptv/" + item.mediaId + "?quality=720p", "hls")
    else if kind = "channel" then
        startPlayback(item, normalizeServer(m.top.serverUrl) + "/sf/hls/" + item.mediaId + "/index.m3u8", "hls")
    else if kind = "video" then
        startPlayback(item, normalizeServer(m.top.serverUrl) + "/api/roku/stream/" + item.mediaId + "?quality=720p", "hls")
    end if
end sub

sub startPlayback(item as Object, url as String, streamFormat as String)
    if item.mediaId = "" then
        m.status.text = "This item is missing its Orion media id."
        return
    end if
    content = CreateObject("roSGNode", "ContentNode")
    content.title = item.title
    content.url = url
    content.streamFormat = streamFormat
    m.status.text = "Starting " + item.title + "..."
    m.video.content = content
    m.video.visible = true
    m.video.control = "play"
    m.video.setFocus(true)
end sub

sub onVideoState()
    state = m.video.state
    if state = "error" then
        m.status.text = "Playback error: " + m.video.errorMsg
        closeVideo()
    else if state = "finished" then
        closeVideo()
    end if
end sub

sub closeVideo()
    m.video.control = "stop"
    m.video.visible = false
    m.rows.setFocus(true)
end sub

sub applyTheme(item as Object)
    if item.backgroundColor <> "" then m.background.color = item.backgroundColor
    m.status.text = item.title + " theme applied to this Roku."
    registry = CreateObject("roRegistrySection", "Orion")
    registry.Write("themeBackground", item.backgroundColor)
    registry.Flush()
end sub

sub openServerDialog()
    dialog = CreateObject("roSGNode", "KeyboardDialog")
    dialog.title = "Orion server address"
    dialog.text = normalizeServer(m.top.serverUrl)
    dialog.buttons = ["Save", "Cancel"]
    dialog.observeField("buttonSelected", "onServerDialog")
    m.serverDialog = dialog
    m.top.dialog = dialog
end sub

sub onServerDialog()
    if m.serverDialog = invalid then return
    if m.serverDialog.buttonSelected = 0 then
        server = normalizeServer(m.serverDialog.text)
        if server = "" then
            m.status.text = "Enter an address such as http://192.168.0.144:3001"
        else
            registry = CreateObject("roRegistrySection", "Orion")
            registry.Write("serverUrl", server)
            registry.Flush()
            m.top.serverUrl = server
        end if
    else
        m.rows.setFocus(true)
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" and m.video.visible then
        closeVideo()
        return true
    end if
    if key = "back" and m.currentView <> "home" then
        m.rows.content = m.homeContent
        m.currentView = "home"
        m.currentSection = ""
        m.currentPage = 0
        m.status.text = "Select a title to play • Press * for server settings"
        m.rows.setFocus(true)
        return true
    end if
    if key = "options" and not m.video.visible then
        openServerDialog()
        return true
    end if
    return false
end function

function itemTitle(item as Object, kind as String) as String
    if kind = "show" then
        name = stringValue(item, "showName")
        if name <> "" then return name
    end if
    return stringValue(item, "title")
end function

function itemSubtitle(item as Object, kind as String) as String
    if kind = "show" then
        count = item.episodeCount
        if count <> invalid then return count.ToStr() + " episodes"
    end if
    if kind = "theme" then return "Apply TV theme"
    group = stringValue(item, "group")
    if group = "" then group = stringValue(item, "artist")
    if group = "" then group = stringValue(item, "year")
    if group = "" and kind = "channel" then group = "Orion channel"
    if group = "" and kind = "iptv" then group = "Live TV"
    return group
end function

function imageUrl(value as String) as String
    if value = "" then return ""
    if Left(value, 4) = "http" then return value
    if Left(value, 1) = "/" then return normalizeServer(m.top.serverUrl) + value
    return ""
end function

function stringValue(item as Object, key as String) as String
    if item = invalid then return ""
    value = item[key]
    if value = invalid then return ""
    return value.ToStr()
end function

function themeColor(item as Object, key as String, fallback as String) as String
    vars = item.vars
    if vars = invalid then return fallback
    value = vars[key]
    if value = invalid or value = "" then return fallback
    return value
end function

function sectionLabel(section as String) as String
    if section = "tvShows" then return "TV Shows"
    if section = "musicVideos" then return "Music Videos"
    if section = "iptv" then return "Live TV"
    if section = "channels" then return "Orion Channels"
    if section = "themes" then return "Themes"
    if section = "movies" then return "Movies"
    if section = "music" then return "Music"
    return section
end function

function kindForSection(section as String) as String
    if section = "tvShows" then return "show"
    if section = "music" then return "music"
    if section = "iptv" then return "iptv"
    if section = "channels" then return "channel"
    if section = "themes" then return "theme"
    return "video"
end function

function countText(value as Dynamic) as String
    if value = invalid then return "0"
    return value.ToStr()
end function

function normalizeServer(value as String) as String
    server = Trim(value)
    while Len(server) > 0 and Right(server, 1) = "/"
        server = Left(server, Len(server) - 1)
    end while
    return server
end function
