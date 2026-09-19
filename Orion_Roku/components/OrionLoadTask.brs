sub init()
    m.top.functionName = "run"
end sub

sub run()
    base = normalizeServer(m.top.serverUrl)
    if base = "" then
        m.top.error = "Press * and enter your Orion server address."
        return
    end if

    mode = m.top.mode
    if mode = "episodes" then
        loadEpisodes(base)
    else if mode = "browse" then
        loadBrowse(base)
    else
        loadHome(base)
    end if
end sub

sub loadHome(base as String)
    movies = fetchPage(base + "/api/library/movies?page=0&limit=60")
    shows = fetchPage(base + "/api/library/tvShows/grouped?page=0&limit=60")
    music = fetchPage(base + "/api/library/music?page=0&limit=60")
    musicVideos = fetchPage(base + "/api/library/musicVideos?page=0&limit=60")
    iptv = fetchPage(base + "/api/roku/iptv?page=0&limit=60")
    channels = fetchArray(base + "/api/sf/channels?light=1")
    themes = fetchArray(base + "/api/themes")

    if movies = invalid and shows = invalid and music = invalid and musicVideos = invalid and iptv = invalid and channels = invalid then
        m.top.error = "Could not reach Orion at " + base
        return
    end if

    data = {
        mode: "home"
        movies: pageItems(movies)
        moviesTotal: pageTotal(movies)
        tvShows: pageItems(shows)
        tvShowsTotal: pageTotal(shows)
        music: pageItems(music)
        musicTotal: pageTotal(music)
        musicVideos: pageItems(musicVideos)
        musicVideosTotal: pageTotal(musicVideos)
        iptv: pageItems(iptv)
        iptvTotal: pageTotal(iptv)
        channels: validArray(channels)
        themes: validArray(themes)
    }
    m.top.payload = FormatJson(data)
end sub

sub loadBrowse(base as String)
    section = m.top.section
    page = m.top.page
    limit = 80
    result = invalid

    if section = "movies" then
        result = fetchPage(base + "/api/library/movies?page=" + page.ToStr() + "&limit=" + limit.ToStr())
    else if section = "tvShows" then
        result = fetchPage(base + "/api/library/tvShows/grouped?page=" + page.ToStr() + "&limit=" + limit.ToStr())
    else if section = "music" then
        result = fetchPage(base + "/api/library/music?page=" + page.ToStr() + "&limit=" + limit.ToStr())
    else if section = "musicVideos" then
        result = fetchPage(base + "/api/library/musicVideos?page=" + page.ToStr() + "&limit=" + limit.ToStr())
    else if section = "iptv" then
        result = fetchPage(base + "/api/roku/iptv?page=" + page.ToStr() + "&limit=" + limit.ToStr())
    else if section = "channels" then
        allChannels = validArray(fetchArray(base + "/api/sf/channels?light=1"))
        result = { items: pageSlice(allChannels, page, limit), total: allChannels.Count() }
    else if section = "themes" then
        allThemes = validArray(fetchArray(base + "/api/themes"))
        result = { items: pageSlice(allThemes, page, limit), total: allThemes.Count() }
    end if

    if result = invalid then
        m.top.error = "Could not load " + section + " from Orion."
        return
    end if

    m.top.payload = FormatJson({
        mode: "browse"
        section: section
        page: page
        limit: limit
        items: pageItems(result)
        total: pageTotal(result)
    })
end sub

sub loadEpisodes(base as String)
    showName = m.top.showName
    if showName = "" then
        m.top.error = "This TV show has no name."
        return
    end if
    data = fetchJson(base + "/api/library/tvShows/byShow/" + urlEscape(showName))
    if data = invalid then
        m.top.error = "Could not load episodes for " + showName
        return
    end if
    items = data.items
    if items = invalid then items = []
    m.top.payload = FormatJson({ mode: "episodes", title: showName, items: items, total: items.Count() })
end sub

function fetchPage(url as String) as Dynamic
    data = fetchJson(url)
    if data = invalid then return invalid
    if data.items = invalid then return { items: [], total: 0 }
    total = data.total
    if total = invalid then total = data.items.Count()
    return { items: data.items, total: total }
end function

function fetchArray(url as String) as Dynamic
    data = fetchJson(url)
    if data = invalid then return invalid
    if type(data) = "roArray" then return data
    if data.items <> invalid then return data.items
    if data.channels <> invalid then return data.channels
    return []
end function

function fetchJson(url as String) as Dynamic
    transfer = CreateObject("roUrlTransfer")
    transfer.SetUrl(url)
    transfer.AddHeader("Accept", "application/json")
    body = transfer.GetToString()
    if transfer.GetResponseCode() <> 200 then return invalid
    return ParseJson(body)
end function

function pageItems(page as Dynamic) as Object
    if page = invalid or page.items = invalid then return []
    return page.items
end function

function pageTotal(page as Dynamic) as Integer
    if page = invalid or page.total = invalid then return 0
    return page.total
end function

function validArray(value as Dynamic) as Object
    if value = invalid then return []
    return value
end function

function pageSlice(items as Object, page as Integer, limit as Integer) as Object
    output = []
    start = page * limit
    finish = start + limit - 1
    if finish >= items.Count() then finish = items.Count() - 1
    if finish < start then return output
    for index = start to finish
        output.Push(items[index])
    end for
    return output
end function

function normalizeServer(value as String) as String
    server = Trim(value)
    while Len(server) > 0 and Right(server, 1) = "/"
        server = Left(server, Len(server) - 1)
    end while
    return server
end function

function urlEscape(value as String) as String
    transfer = CreateObject("roUrlTransfer")
    return transfer.Escape(value)
end function
