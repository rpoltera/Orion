sub init()
    m.rows = m.top.findNode("rows")
    m.status = m.top.findNode("status")
    m.serverLabel = m.top.findNode("server")
    m.background = m.top.findNode("background")
    m.title = m.top.findNode("title")
    m.video = m.top.findNode("video")
    m.currentView = "profiles"
    m.currentSection = ""
    m.currentPage = 0
    m.rows.observeField("rowItemSelected", "onItemSelected")
    m.video.observeField("state", "onVideoState")
    m.top.observeField("serverUrl", "onServerChanged")
    applySavedTheme()

    registry = CreateObject("roRegistrySection", "Orion")
    m.token = registry.Read("userToken")
    if normalizeServer(m.top.serverUrl) = "" then
        m.status.text = "Press * to connect Orion."
    else if m.token <> "" then
        loadHome()
    else
        loadProfiles()
    end if
    m.rows.setFocus(true)
end sub

sub onServerChanged()
    if normalizeServer(m.top.serverUrl) <> "" then
        registry = CreateObject("roRegistrySection", "Orion")
        m.token = registry.Read("userToken")
        if m.token <> "" then loadHome() else loadProfiles()
    end if
end sub

sub loadProfiles()
    m.currentView = "profiles"
    m.currentSection = ""
    m.serverLabel.text = "Server: " + normalizeServer(m.top.serverUrl) + "   •   * Server settings"
    m.status.text = "Loading Orion profiles..."
    startLoader("profiles", "", 0, "", "", "")
end sub

sub loadHome()
    m.currentView = "home"
    m.currentSection = ""
    m.currentPage = 0
    m.serverLabel.text = "Server: " + normalizeServer(m.top.serverUrl) + "   •   * Settings"
    m.status.text = "Loading your Orion library..."
    startLoader("home", "", 0, "", "", "")
end sub

sub loadBrowse(section as String, page as Integer)
    m.currentView = "browse"
    m.currentSection = section
    m.currentPage = page
    m.status.text = "Loading " + sectionLabel(section) + "..."
    startLoader("browse", section, page, "", "", "")
end sub

sub loadEpisodes(showName as String)
    m.currentView = "episodes"
    m.status.text = "Loading " + showName + "..."
    startLoader("episodes", "", 0, showName, "", "")
end sub

sub startLogin(userName as String, credential as String)
    m.status.text = "Signing in " + userName + "..."
    startLoader("login", "", 0, "", userName, credential)
end sub

sub startLoader(mode as String, section as String, page as Integer, showName as String, userName as String, credential as String)
    m.loader = CreateObject("roSGNode", "OrionLoadTask")
    m.loader.serverUrl = normalizeServer(m.top.serverUrl)
    m.loader.mode = mode
    m.loader.section = section
    m.loader.page = page
    m.loader.showName = showName
    m.loader.token = m.token
    m.loader.userName = userName
    m.loader.credential = credential
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

    if data.mode = "profiles" then
        renderProfiles(data)
    else if data.mode = "login" then
        onLogin(data)
    else if data.mode = "home" then
        renderHome(data)
    else if data.mode = "episodes" then
        renderEpisodes(data)
    else if data.mode = "browse" then
        renderBrowse(data)
    end if
end sub

sub onLibraryError()
    if m.loader = invalid or m.loader.error = "" then return
    m.status.text = m.loader.error
    if Instr(1, m.loader.error, "Session expired") > 0 then
        clearProfile()
        loadProfiles()
    end if
end sub

sub renderProfiles(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = "Choose your Orion profile"
    for each user in data.users
        node = createNode(row)
        node.title = stringValue(user, "name")
        node.shortDescriptionLine1 = profileSubtitle(user)
        node.orionKind = "profile"
        node.userName = stringValue(user, "name")
        node.accentColor = "2563EB"
    end for
    m.rows.content = root
    m.status.text = "Select a profile • Press * for server settings"
    m.rows.setFocus(true)
end sub

sub onLogin(data as Object)
    if data.token = invalid or data.token = "" then
        m.status.text = "Orion did not return a sign-in token."
        return
    end if
    m.token = data.token
    registry = CreateObject("roRegistrySection", "Orion")
    registry.Write("userToken", m.token)
    registry.Flush()
    loadHome()
end sub

sub renderHome(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    m.homeContent = root
    m.currentUser = data.user
    addProfileRow(root, data.user)
    addNavigationRow(root)
    for each rowData in data.rows
        addCatalogRow(root, rowData)
    end for
    addMediaRow(root, "Live TV (IPTV) · " + countText(data.iptvTotal), data.iptv, "iptv", "iptv")
    addMediaRow(root, "Orion Live Channels · " + countText(data.channelsTotal), data.channels, "channel", "channels")
    m.rows.content = root
    m.status.text = "Select a title to play • Press * for server settings"
    m.rows.setFocus(true)
end sub

sub renderBrowse(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = sectionLabel(data.section) + " · Page " + (data.page + 1).ToStr() + " · " + countText(data.total)
    for each item in data.items
        addItem(row, item, stringValue(item, "kind"), data.section)
    end for
    if (data.page + 1) * data.limit < data.total then addMoreItem(row, data.section, data.page + 1)
    m.rows.content = root
    m.currentView = "browse"
    m.currentSection = data.section
    m.currentPage = data.page
    m.status.text = "Back returns to your Orion home"
    m.rows.setFocus(true)
end sub

sub renderEpisodes(data as Object)
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = data.title + " · " + countText(data.total) + " Episodes"
    for each item in data.items
        addItem(row, item, "video", "tvShows")
    end for
    m.rows.content = root
    m.currentView = "episodes"
    m.status.text = "Select an episode to play • Back returns to your Orion home"
    m.rows.setFocus(true)
end sub

sub addProfileRow(root as Object, user as Object)
    if user = invalid then return
    row = root.createChild("ContentNode")
    row.title = "Current Profile"
    node = createNode(row)
    node.title = stringValue(user, "name")
    node.shortDescriptionLine1 = "Switch profile"
    node.orionKind = "switchProfile"
    node.accentColor = "2563EB"
end sub

sub addNavigationRow(root as Object)
    row = root.createChild("ContentNode")
    row.title = "Browse All Orion"
    entries = [
        { title: "All Movies", section: "movies", color: "1F5EDB" }
        { title: "All TV Shows", section: "tvShows", color: "7936B5" }
        { title: "All Music", section: "music", color: "B45309" }
        { title: "All Music Videos", section: "musicVideos", color: "BD3B72" }
        { title: "All Collections", section: "collections", color: "0F766E" }
        { title: "Movie Categories", section: "genres:movies", color: "7C3AED" }
        { title: "TV Categories", section: "genres:tvShows", color: "7C3AED" }
        { title: "Music Categories", section: "genres:music", color: "7C3AED" }
        { title: "Live TV", section: "iptv", color: "0F766E" }
        { title: "Orion Channels", section: "channels", color: "0B68B8" }
        { title: "Server Themes", section: "themes", color: "6D28D9" }
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

sub addCatalogRow(root as Object, rowData as Object)
    items = rowData.items
    if items = invalid or items.Count() = 0 then return
    row = root.createChild("ContentNode")
    row.title = stringValue(rowData, "title")
    for each item in items
        addItem(row, item, stringValue(item, "kind"), stringValue(item, "section"))
    end for
    section = stringValue(rowData, "section")
    if section <> "" and items.Count() < 48 then return
    if section <> "" then addBrowseAllItem(row, section)
end sub

sub addMediaRow(root as Object, label as String, items as Object, kind as String, section as String)
    if items = invalid or items.Count() = 0 then return
    row = root.createChild("ContentNode")
    row.title = label
    for each item in items
        addItem(row, item, kind, section)
    end for
    addBrowseAllItem(row, section)
end sub

sub addItem(row as Object, item as Object, kind as String, section as String)
    node = createNode(row)
    node.orionKind = kind
    node.section = section
    if stringValue(item, "section") <> "" then node.section = stringValue(item, "section")
    node.mediaId = stringValue(item, "id")
    node.title = itemTitle(item, kind)
    node.shortDescriptionLine1 = itemSubtitle(item, kind)
    node.hdPosterUrl = imageUrl(stringValue(item, "thumbnail"))
    node.showName = stringValue(item, "showName")
    if kind = "theme" then
        node.accentColor = themeColor(item, "--accent", "6D28D9")
        node.backgroundColor = themeColor(item, "--bg-primary", "080D1A")
        node.cardColor = themeColor(item, "--bg-card", "171D33")
        node.textColor = themeColor(item, "--text-primary", "F9FAFB")
        node.mutedColor = themeColor(item, "--text-secondary", "9CA3AF")
    else if stringValue(item, "accentColor") <> "" then
        node.accentColor = stringValue(item, "accentColor")
    else if kind = "channel" then
        node.accentColor = "0B68B8"
    else if kind = "iptv" then
        node.accentColor = "0F766E"
    else if kind = "collection" then
        node.accentColor = "0F766E"
    else if kind = "genre" then
        node.accentColor = "7C3AED"
    end if
end sub

sub addBrowseAllItem(row as Object, section as String)
    node = createNode(row)
    node.title = "Browse All"
    node.shortDescriptionLine1 = sectionLabel(section)
    node.orionKind = "section"
    node.section = section
    node.accentColor = "334155"
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
        userName: ""
        section: ""
        page: 0
        accentColor: ""
        backgroundColor: ""
        cardColor: ""
        textColor: ""
        mutedColor: ""
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
    if kind = "profile" then
        openPinDialog(item.userName)
    else if kind = "switchProfile" then
        clearProfile()
        loadProfiles()
    else if kind = "section" or kind = "collection" or kind = "genre" then
        loadBrowse(item.section, 0)
    else if kind = "more" then
        loadBrowse(item.section, item.page)
    else if kind = "show" then
        loadEpisodes(item.showName)
    else if kind = "theme" then
        applyTheme(item)
    else if kind = "music" then
        startPlayback(item, appendToken(normalizeServer(m.top.serverUrl) + "/api/roku/audio/" + item.mediaId), "mp3")
    else if kind = "iptv" then
        startPlayback(item, appendToken(normalizeServer(m.top.serverUrl) + "/api/roku/iptv/" + item.mediaId + "?quality=720p"), "hls")
    else if kind = "channel" then
        startPlayback(item, normalizeServer(m.top.serverUrl) + "/sf/hls/" + item.mediaId + "/index.m3u8", "hls")
    else if kind = "video" then
        startPlayback(item, appendToken(normalizeServer(m.top.serverUrl) + "/api/roku/stream/" + item.mediaId + "?quality=720p"), "hls")
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

sub openPinDialog(userName as String)
    m.pendingUserName = userName
    dialog = CreateObject("roSGNode", "KeyboardDialog")
    dialog.title = "Enter PIN or password for " + userName
    dialog.text = ""
    dialog.buttons = ["Sign In", "Cancel"]
    dialog.optionsDialog = true
    dialog.observeField("buttonSelected", "onPinDialog")
    m.pinDialog = dialog
    m.top.dialog = dialog
end sub

sub onPinDialog(event as Object)
    if event = invalid then return
    credential = m.top.dialog.text
    m.top.dialog = invalid
    if event.getData() = 0 then
        startLogin(m.pendingUserName, credential)
    else
        m.rows.setFocus(true)
    end if
end sub

sub openServerDialog()
    dialog = CreateObject("roSGNode", "KeyboardDialog")
    dialog.title = "Orion server address"
    dialog.text = normalizeServer(m.top.serverUrl)
    dialog.buttons = ["Save", "Cancel"]
    dialog.optionsDialog = true
    dialog.observeField("buttonSelected", "onServerDialog")
    m.serverDialog = dialog
    m.top.dialog = dialog
end sub

sub onServerDialog(event as Object)
    if event = invalid then return
    server = normalizeServer(m.top.dialog.text)
    m.top.dialog = invalid
    if event.getData() = 0 then
        if server = "" then
            m.status.text = "Enter an address such as http://192.168.0.244:3001"
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

sub clearProfile()
    m.token = ""
    registry = CreateObject("roRegistrySection", "Orion")
    registry.Delete("userToken")
    registry.Flush()
end sub

sub applyTheme(item as Object)
    registry = CreateObject("roRegistrySection", "Orion")
    registry.Write("themeBackground", rokuColor(item.backgroundColor, "080D1A"))
    registry.Write("themeCard", rokuColor(item.cardColor, "171D33"))
    registry.Write("themeAccent", rokuColor(item.accentColor, "2563EB"))
    registry.Write("themeText", rokuColor(item.textColor, "F9FAFB"))
    registry.Write("themeMuted", rokuColor(item.mutedColor, "9CA3AF"))
    registry.Flush()
    applySavedTheme()
    m.status.text = item.title + " is now your Roku theme."
    loadHome()
end sub

sub applySavedTheme()
    registry = CreateObject("roRegistrySection", "Orion")
    m.background.color = rokuColor(registry.Read("themeBackground"), "080D1A")
    m.title.color = rokuColor(registry.Read("themeText"), "F9FAFB")
    m.status.color = rokuColor(registry.Read("themeMuted"), "9CA3AF")
    m.serverLabel.color = rokuColor(registry.Read("themeMuted"), "9CA3AF")
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" and m.video.visible then
        closeVideo()
        return true
    end if
    if key = "back" and (m.currentView = "browse" or m.currentView = "episodes") then
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
    title = stringValue(item, "title")
    if title = "" then title = "Untitled"
    return title
end function

function itemSubtitle(item as Object, kind as String) as String
    subtitle = stringValue(item, "subtitle")
    if subtitle <> "" then return subtitle
    if kind = "theme" then return "Apply this server theme"
    if kind = "channel" then return "Orion live channel"
    if kind = "iptv" then return "Live TV"
    return stringValue(item, "year")
end function

function profileSubtitle(user as Object) as String
    label = stringValue(user, "role")
    maxRating = stringValue(user, "maxRating")
    if maxRating <> "" then label = label + " • Up to " + maxRating
    if label = "" then label = "Orion profile"
    return label
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
    return rokuColor(value, fallback)
end function

function appendToken(url as String) as String
    if m.token = "" then return url
    separator = "?"
    if Instr(1, url, "?") > 0 then separator = "&"
    return url + separator + "token=" + m.token
end function

function sectionLabel(section as String) as String
    if section = "tvShows" then return "TV Shows"
    if section = "musicVideos" then return "Music Videos"
    if section = "iptv" then return "Live TV"
    if section = "channels" then return "Orion Channels"
    if section = "themes" then return "Themes"
    if section = "collections" then return "Collections"
    if Left(section, 7) = "genres:" then return "Categories"
    if Left(section, 6) = "genre:" then return "Category"
    if Left(section, 11) = "collection:" then return "Collection"
    if Left(section, 7) = "custom:" then return "Library"
    return section
end function

function countText(value as Dynamic) as String
    if value = invalid then return "0"
    return value.ToStr()
end function

function normalizeServer(value as String) as String
    server = value.Trim()
    while Len(server) > 0 and Right(server, 1) = "/"
        server = Left(server, Len(server) - 1)
    end while
    return server
end function

function rokuColor(value as Dynamic, fallback as String) as String
    color = ""
    if value <> invalid then color = value.ToStr()
    if Left(color, 1) = "#" then color = Mid(color, 2)
    if Len(color) <> 6 then color = fallback
    if Left(color, 1) = "#" then color = Mid(color, 2)
    return UCase(color)
end function
