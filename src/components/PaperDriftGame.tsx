'use client'

import React, { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import * as CANNON from 'cannon-es'

interface GameStats {
  score: number
  distance: number
  combo: number
  gravityState: 'up' | 'down'
}

interface PaperPlane {
  mesh: THREE.Mesh
  body: CANNON.Body
}

interface Room {
  mesh: THREE.Group
  bodies: CANNON.Body[]
  position: number
  type: string
}

interface CollectibleRing {
  mesh: THREE.Mesh
  body: CANNON.Body
  collected: boolean
}

export default function PaperDriftGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [gameStarted, setGameStarted] = useState(false)
  const [gameStats, setGameStats] = useState<GameStats>({
    score: 0,
    distance: 0,
    combo: 0,
    gravityState: 'down'
  })

  // Game state refs
  const gameRefs = useRef({
    scene: null as THREE.Scene | null,
    camera: null as THREE.PerspectiveCamera | null,
    renderer: null as THREE.WebGLRenderer | null,
    world: null as CANNON.World | null,
    paperPlane: null as PaperPlane | null,
    gravityDirection: 1, // 1 for down, -1 for up
    gravityTransition: 0, // 0-1 for smooth transition
    isTransitioning: false,
    keys: {
      left: false,
      right: false
    },
    rooms: [] as Room[],
    collectibles: [] as CollectibleRing[],
    nextRoomPosition: 0,
    rng: null as (() => number) | null,
    roomTemplates: [] as any[],
    // Object pools for performance
    meshPool: [] as THREE.Mesh[],
    geometryPool: [] as THREE.BufferGeometry[],
    materialPool: [] as THREE.Material[],
    bodyPool: [] as CANNON.Body[],
    lastFrameTime: 0,
    frameCount: 0,
    fps: 0
  })

  const generateRandomNumber = useCallback((min: number, max: number) => {
    return Math.random() * (max - min) + min
  }, [])

  // Object pooling functions for performance
  const getPooledGeometry = useCallback((type: string, ...params: any[]) => {
    const refs = gameRefs.current
    for (let i = 0; i < refs.geometryPool.length; i++) {
      const geom = refs.geometryPool[i]
      if (!geom.userData.inUse) {
        geom.userData.inUse = true
        return geom
      }
    }

    // Create new geometry if none available in pool
    let newGeometry: THREE.BufferGeometry
    switch (type) {
      case 'plane':
        newGeometry = new THREE.PlaneGeometry(...params)
        break
      case 'box':
        newGeometry = new THREE.BoxGeometry(...params)
        break
      case 'torus':
        newGeometry = new THREE.TorusGeometry(...params)
        break
      case 'cone':
        newGeometry = new THREE.ConeGeometry(...params)
        break
      default:
        newGeometry = new THREE.BoxGeometry(...params)
    }
    newGeometry.userData = { inUse: true }
    refs.geometryPool.push(newGeometry)
    return newGeometry
  }, [])

  const releaseGeometry = useCallback((geometry: THREE.BufferGeometry) => {
    geometry.userData.inUse = false
  }, [])

  const getPooledMaterial = useCallback((color: number, transparent = false, opacity = 1) => {
    const refs = gameRefs.current
    for (let i = 0; i < refs.materialPool.length; i++) {
      const mat = refs.materialPool[i]
      if (!mat.userData.inUse &&
          (mat as THREE.MeshLambertMaterial).color.getHex() === color &&
          mat.transparent === transparent &&
          mat.opacity === opacity) {
        mat.userData.inUse = true
        return mat
      }
    }

    // Create new material if none available
    const newMaterial = new THREE.MeshLambertMaterial({
      color,
      transparent,
      opacity
    })
    newMaterial.userData = { inUse: true }
    refs.materialPool.push(newMaterial)
    return newMaterial
  }, [])

  const releaseMaterial = useCallback((material: THREE.Material) => {
    material.userData.inUse = false
  }, [])

  const createRoomTemplate = useCallback((type: string) => {
    const templates = {
      office: {
        width: 20,
        height: 20,
        depth: 30,
        color: 0xF5F5DC,
        obstacles: [
          { type: 'desk', position: [0, 0, 0], size: [3, 1, 2] },
          { type: 'shelf', position: [-8, 0, -5], size: [1, 6, 3] },
          { type: 'shelf', position: [8, 0, -5], size: [1, 6, 3] }
        ]
      },
      warehouse: {
        width: 25,
        height: 25,
        depth: 40,
        color: 0xD3D3D3,
        obstacles: [
          { type: 'crate', position: [-6, 0, -10], size: [2, 2, 2] },
          { type: 'crate', position: [6, 0, -10], size: [2, 2, 2] },
          { type: 'crate', position: [0, 0, -15], size: [3, 3, 3] }
        ]
      },
      lab: {
        width: 18,
        height: 18,
        depth: 25,
        color: 0xE6E6FA,
        obstacles: [
          { type: 'table', position: [0, 0, -5], size: [4, 1, 2] },
          { type: 'machine', position: [-7, 0, -10], size: [2, 4, 2] },
          { type: 'machine', position: [7, 0, -10], size: [2, 4, 2] }
        ]
      }
    }

    return templates[type as keyof typeof templates] || templates.office
  }, [])

  const createRoom = useCallback((position: number, type: string = 'office') => {
    const refs = gameRefs.current
    if (!refs.scene || !refs.world) return null

    const template = createRoomTemplate(type)
    const roomGroup = new THREE.Group()
    const bodies: CANNON.Body[] = []

    // Create floor
    const floorGeometry = new THREE.PlaneGeometry(template.width, template.depth)
    const floorMaterial = new THREE.MeshLambertMaterial({ color: template.color })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -template.height / 2
    floor.position.z = position
    floor.receiveShadow = true
    roomGroup.add(floor)

    const floorShape = new CANNON.Box(new CANNON.Vec3(template.width / 2, 0.1, template.depth / 2))
    const floorBody = new CANNON.Body({
      mass: 0,
      shape: floorShape,
      position: new CANNON.Vec3(0, -template.height / 2, position)
    })
    refs.world.addBody(floorBody)
    bodies.push(floorBody)

    // Create ceiling
    const ceilingGeometry = new THREE.PlaneGeometry(template.width, template.depth)
    const ceilingMaterial = new THREE.MeshLambertMaterial({ color: template.color })
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial)
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.y = template.height / 2
    ceiling.position.z = position
    ceiling.receiveShadow = true
    roomGroup.add(ceiling)

    const ceilingShape = new CANNON.Box(new CANNON.Vec3(template.width / 2, 0.1, template.depth / 2))
    const ceilingBody = new CANNON.Body({
      mass: 0,
      shape: ceilingShape,
      position: new CANNON.Vec3(0, template.height / 2, position)
    })
    refs.world.addBody(ceilingBody)
    bodies.push(ceilingBody)

    // Create walls
    const wallMaterial = new THREE.MeshLambertMaterial({ color: template.color })

    // Left wall
    const leftWallGeometry = new THREE.PlaneGeometry(template.depth, template.height)
    const leftWall = new THREE.Mesh(leftWallGeometry, wallMaterial)
    leftWall.rotation.y = Math.PI / 2
    leftWall.position.x = -template.width / 2
    leftWall.position.z = position
    leftWall.receiveShadow = true
    roomGroup.add(leftWall)

    const leftWallShape = new CANNON.Box(new CANNON.Vec3(0.1, template.height / 2, template.depth / 2))
    const leftWallBody = new CANNON.Body({
      mass: 0,
      shape: leftWallShape,
      position: new CANNON.Vec3(-template.width / 2, 0, position)
    })
    refs.world.addBody(leftWallBody)
    bodies.push(leftWallBody)

    // Right wall
    const rightWallGeometry = new THREE.PlaneGeometry(template.depth, template.height)
    const rightWall = new THREE.Mesh(rightWallGeometry, wallMaterial)
    rightWall.rotation.y = -Math.PI / 2
    rightWall.position.x = template.width / 2
    rightWall.position.z = position
    rightWall.receiveShadow = true
    roomGroup.add(rightWall)

    const rightWallShape = new CANNON.Box(new CANNON.Vec3(0.1, template.height / 2, template.depth / 2))
    const rightWallBody = new CANNON.Body({
      mass: 0,
      shape: rightWallShape,
      position: new CANNON.Vec3(template.width / 2, 0, position)
    })
    refs.world.addBody(rightWallBody)
    bodies.push(rightWallBody)

    // Add obstacles
    template.obstacles.forEach((obstacle: any) => {
      const obstacleGeometry = new THREE.BoxGeometry(...obstacle.size)
      const obstacleMaterial = new THREE.MeshLambertMaterial({ color: 0x8B4513 })
      const obstacleMesh = new THREE.Mesh(obstacleGeometry, obstacleMaterial)
      obstacleMesh.position.set(...obstacle.position)
      obstacleMesh.position.z += position
      obstacleMesh.castShadow = true
      obstacleMesh.receiveShadow = true
      roomGroup.add(obstacleMesh)

      const obstacleShape = new CANNON.Box(new CANNON.Vec3(
        obstacle.size[0] / 2,
        obstacle.size[1] / 2,
        obstacle.size[2] / 2
      ))
      const obstacleBody = new CANNON.Body({
        mass: 0,
        shape: obstacleShape,
        position: new CANNON.Vec3(
          obstacle.position[0],
          obstacle.position[1],
          obstacle.position[2] + position
        )
      })
      refs.world.addBody(obstacleBody)
      bodies.push(obstacleBody)
    })

    // Add collectible rings
    if (Math.random() > 0.3) { // 70% chance of having a ring
      const ringGeometry = new THREE.TorusGeometry(1, 0.2, 8, 16)
      const ringMaterial = new THREE.MeshLambertMaterial({
        color: 0xFFD700,
        transparent: true,
        opacity: 0.8
      })
      const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial)
      ringMesh.position.set(
        generateRandomNumber(-template.width / 3, template.width / 3),
        generateRandomNumber(-template.height / 3, template.height / 3),
        position + generateRandomNumber(-template.depth / 3, template.depth / 3)
      )
      roomGroup.add(ringMesh)

      // Add physics trigger for ring (non-colliding)
      const ringShape = new CANNON.Sphere(1.5)
      const ringBody = new CANNON.Body({
        mass: 0,
        shape: ringShape,
        collisionFilterGroup: 2, // Different collision group
        collisionFilterMask: 1, // Only collide with plane
        position: new CANNON.Vec3(
          ringMesh.position.x,
          ringMesh.position.y,
          ringMesh.position.z
        )
      })
      refs.world.addBody(ringBody)

      refs.collectibles.push({
        mesh: ringMesh,
        body: ringBody,
        collected: false
      })
    }

    refs.scene.add(roomGroup)

    return {
      mesh: roomGroup,
      bodies,
      position,
      type
    }
  }, [createRoomTemplate, generateRandomNumber])

  const updateRooms = useCallback(() => {
    const refs = gameRefs.current
    if (!refs.paperPlane || !refs.scene || !refs.world) return

    const planeZ = refs.paperPlane.body.position.z

    // Remove rooms that are far behind the plane
    refs.rooms = refs.rooms.filter(room => {
      if (room.position < planeZ - 50) {
        // Remove room from scene
        refs.scene!.remove(room.mesh)
        // Remove physics bodies
        room.bodies.forEach(body => {
          refs.world!.removeBody(body)
        })
        return false
      }
      return true
    })

    // Add new rooms ahead of the plane
    while (refs.nextRoomPosition < planeZ + 100) {
      const roomTypes = ['office', 'warehouse', 'lab']
      const randomType = roomTypes[Math.floor(Math.random() * roomTypes.length)]
      const newRoom = createRoom(refs.nextRoomPosition, randomType)
      if (newRoom) {
        refs.rooms.push(newRoom)
      }
      refs.nextRoomPosition += 30 // Room spacing
    }
  }, [createRoom])

  const checkCollectibles = useCallback(() => {
    const refs = gameRefs.current
    if (!refs.paperPlane) return

    refs.collectibles.forEach(collectible => {
      if (!collectible.collected) {
        const distance = refs.paperPlane!.body.position.distanceTo(collectible.body.position)
        if (distance < 2) {
          collectible.collected = true
          refs.scene!.remove(collectible.mesh)
          refs.world!.removeBody(collectible.body)

          // Update score
          setGameStats(prev => ({
            ...prev,
            score: prev.score + 100,
            combo: prev.combo + 1
          }))
        }
      }
    })

    // Remove collected collectibles from array
    refs.collectibles = refs.collectibles.filter(c => !c.collected)
  }, [])

  const applyAerodynamicForces = useCallback((planeBody: CANNON.Body, deltaTime: number) => {
    const velocity = planeBody.velocity
    const speed = velocity.length()

    if (speed > 0.1) {
      // Calculate lift force (perpendicular to velocity)
      const liftDirection = new CANNON.Vec3(0, 1, 0)
      const liftMagnitude = speed * speed * 0.02 * gameRefs.current.gravityDirection
      const liftForce = liftDirection.scale(liftMagnitude)

      // Apply lift
      planeBody.applyForce(liftForce, planeBody.position)

      // Apply drag (opposite to velocity)
      const dragMagnitude = speed * speed * 0.01
      const dragForce = velocity.scale(-dragMagnitude / speed)
      planeBody.applyForce(dragForce, planeBody.position)

      // Apply steering forces
      if (gameRefs.current.keys.left) {
        planeBody.applyTorque(new CANNON.Vec3(0, 0, 0.5))
      }
      if (gameRefs.current.keys.right) {
        planeBody.applyTorque(new CANNON.Vec3(0, 0, -0.5))
      }
    }
  }, [])

  const flipGravity = useCallback(() => {
    const refs = gameRefs.current
    if (!refs.isTransitioning && refs.world) {
      refs.isTransitioning = true
      refs.gravityDirection *= -1
      refs.gravityTransition = 0

      setGameStats(prev => ({
        ...prev,
        gravityState: prev.gravityState === 'down' ? 'up' : 'down'
      }))
    }
  }, [])

  useEffect(() => {
    console.log('useEffect triggered:', { canvasRef: canvasRef.current, gameStarted })
    if (!canvasRef.current || !gameStarted) return

    const initGame = async () => {
      const refs = gameRefs.current

      // Initialize Three.js scene
      refs.scene = new THREE.Scene()
      refs.scene.fog = new THREE.Fog(0x87CEEB, 10, 100)
      refs.scene.background = new THREE.Color(0x87CEEB) // Add sky blue background

              // Initialize camera
        refs.camera = new THREE.PerspectiveCamera(
          75,
          window.innerWidth / window.innerHeight,
          0.1,
          1000
        )
        refs.camera.position.set(0, 5, 10)
        refs.camera.lookAt(0, 0, 0) // Ensure camera is looking at origin

      // Initialize renderer
      refs.renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true,
        alpha: false
      })
              refs.renderer.setSize(window.innerWidth, window.innerHeight)
        refs.renderer.shadowMap.enabled = true
        refs.renderer.shadowMap.type = THREE.PCFSoftShadowMap
        refs.renderer.setClearColor(0x87CEEB, 1) // Set clear color
        
        // Ensure canvas is properly sized
        canvasRef.current.width = window.innerWidth
        canvasRef.current.height = window.innerHeight
        
        console.log('Canvas size set to:', window.innerWidth, 'x', window.innerHeight)
        console.log('Canvas element size:', canvasRef.current.width, 'x', canvasRef.current.height)

      // Initialize physics world
      refs.world = new CANNON.World()
      refs.world.gravity.set(0, -9.82, 0)
      refs.world.broadphase = new CANNON.NaiveBroadphase()
      refs.world.solver.iterations = 10

      // Lighting
      const ambientLight = new THREE.AmbientLight(0x404040, 0.6)
      refs.scene.add(ambientLight)

      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
      directionalLight.position.set(10, 10, 5)
      directionalLight.castShadow = true
      directionalLight.shadow.camera.near = 0.1
      directionalLight.shadow.camera.far = 50
      directionalLight.shadow.camera.left = -20
      directionalLight.shadow.camera.right = 20
      directionalLight.shadow.camera.top = 20
      directionalLight.shadow.camera.bottom = -20
      refs.scene.add(directionalLight)

      // Create paper plane
      const createPaperPlane = () => {
        // Paper plane geometry
        const geometry = new THREE.ConeGeometry(0.5, 2, 8)
        const material = new THREE.MeshLambertMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9
        })
        const planeMesh = new THREE.Mesh(geometry, material)
        planeMesh.rotation.z = Math.PI / 2
        planeMesh.castShadow = true
        refs.scene!.add(planeMesh)

        // Physics body for paper plane
        const planeShape = new CANNON.Box(new CANNON.Vec3(1, 0.1, 0.5))
        const planeBody = new CANNON.Body({
          mass: 0.1,
          shape: planeShape,
          position: new CANNON.Vec3(0, 5, 0),
          collisionFilterGroup: 1,
          collisionFilterMask: 0xFFFF,
          material: new CANNON.Material({
            friction: 0.1,
            restitution: 0.1
          })
        })
        refs.world!.addBody(planeBody)

        return { mesh: planeMesh, body: planeBody }
      }

              refs.paperPlane = createPaperPlane()

        // Add a simple test cube to verify rendering
        const testGeometry = new THREE.BoxGeometry(2, 2, 2)
        const testMaterial = new THREE.MeshLambertMaterial({ color: 0xff0000 })
        const testCube = new THREE.Mesh(testGeometry, testMaterial)
        testCube.position.set(0, 0, -5)
        refs.scene.add(testCube)

        // Create initial rooms
      for (let i = 0; i < 5; i++) {
        const roomTypes = ['office', 'warehouse', 'lab']
        const randomType = roomTypes[Math.floor(Math.random() * roomTypes.length)]
        const room = createRoom(i * 30, randomType)
        if (room) {
          refs.rooms.push(room)
        }
      }
      refs.nextRoomPosition = 5 * 30

      // Input handlers
      const handleKeyDown = (event: KeyboardEvent) => {
        switch(event.code) {
          case 'Space':
          case 'ArrowUp':
            event.preventDefault()
            flipGravity()
            break
          case 'ArrowLeft':
          case 'KeyA':
            refs.keys.left = true
            break
          case 'ArrowRight':
          case 'KeyD':
            refs.keys.right = true
            break
        }
      }

      const handleKeyUp = (event: KeyboardEvent) => {
        switch(event.code) {
          case 'ArrowLeft':
          case 'KeyA':
            refs.keys.left = false
            break
          case 'ArrowRight':
          case 'KeyD':
            refs.keys.right = false
            break
        }
      }

      const handleClick = () => {
        flipGravity()
      }

      window.addEventListener('keydown', handleKeyDown)
      window.addEventListener('keyup', handleKeyUp)
      window.addEventListener('click', handleClick)

              // Handle window resize
        const handleResize = () => {
          if (refs.camera && refs.renderer) {
            refs.camera.aspect = window.innerWidth / window.innerHeight
            refs.camera.updateProjectionMatrix()
            refs.renderer.setSize(window.innerWidth, window.innerHeight)
            console.log('Resized to:', window.innerWidth, 'x', window.innerHeight)
          }
        }
        window.addEventListener('resize', handleResize)
        // Initial resize call
        handleResize()

      // Game loop
      let lastTime = 0
      const gameLoop = (time: number) => {
        const deltaTime = Math.min((time - lastTime) / 1000, 0.1)
        lastTime = time

        // FPS tracking
        refs.frameCount++
        if (time - refs.lastFrameTime >= 1000) {
          refs.fps = Math.round(refs.frameCount * 1000 / (time - refs.lastFrameTime))
          refs.frameCount = 0
          refs.lastFrameTime = time
        }

        if (deltaTime > 0 && refs.world && refs.paperPlane && refs.camera && refs.scene && refs.renderer) {
          // Handle gravity transition
          if (refs.isTransitioning) {
            refs.gravityTransition += deltaTime * 3 // 300ms transition
            if (refs.gravityTransition >= 1) {
              refs.gravityTransition = 1
              refs.isTransitioning = false
            }

            // Smooth gravity interpolation
            const targetGravity = -9.82 * refs.gravityDirection
            const currentGravity = refs.world.gravity.y
            const newGravity = currentGravity + (targetGravity - currentGravity) * refs.gravityTransition
            refs.world.gravity.set(0, newGravity, 0)
          }

          // Apply aerodynamic forces
          applyAerodynamicForces(refs.paperPlane.body, deltaTime)

          // Update physics
          refs.world.step(1/60, deltaTime, 3)

          // Sync physics with rendering
          refs.paperPlane.mesh.position.copy(refs.paperPlane.body.position as unknown as THREE.Vector3)
          refs.paperPlane.mesh.quaternion.copy(refs.paperPlane.body.quaternion as unknown as THREE.Quaternion)

          // Update camera to follow plane
          refs.camera.position.lerp(
            new THREE.Vector3(
              refs.paperPlane.body.position.x,
              refs.paperPlane.body.position.y + 5,
              refs.paperPlane.body.position.z + 10
            ),
            0.1
          )
          refs.camera.lookAt(refs.paperPlane.body.position)

          // Update rooms and collectibles
          updateRooms()
          checkCollectibles()

          // Update game stats
          setGameStats(prev => ({
            ...prev,
            distance: Math.max(prev.distance, Math.abs(refs.paperPlane!.body.position.z))
          }))
        }

        if (refs.renderer && refs.scene && refs.camera) {
          refs.renderer.render(refs.scene, refs.camera)
          if (lastTime === 0) {
            console.log('First frame rendered successfully')
          }
        }
        console.log('Starting game loop...')
        requestAnimationFrame(gameLoop)
      }

      requestAnimationFrame(gameLoop)

      // Cleanup
      return () => {
        window.removeEventListener('keydown', handleKeyDown)
        window.removeEventListener('keyup', handleKeyUp)
        window.removeEventListener('click', handleClick)
        window.removeEventListener('resize', handleResize)
        if (refs.renderer) {
          refs.renderer.dispose()
        }
      }
    }

    initGame()
  }, [gameStarted, applyAerodynamicForces, flipGravity, updateRooms, checkCollectibles, createRoom])

  const handleStartGame = () => {
    console.log('Starting game...')
    setGameStarted(true)
  }

  if (!gameStarted) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-blue-400 to-blue-600 text-white">
        <h1 className="text-6xl font-bold mb-4">Paper Drift: Gravity Flip</h1>
        <p className="text-xl mb-8 text-center max-w-2xl">
          Control a paper plane through endless rooms. Flip gravity to navigate through obstacles and collect rings!
        </p>
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-semibold mb-4">Controls</h2>
          <div className="space-y-2">
            <p>🖱️ Click/Tap or Space: Flip Gravity</p>
            <p>⬅️➡️ Arrow Keys or A/D: Steer</p>
          </div>
        </div>
        <button
          onClick={handleStartGame}
          className="px-8 py-4 bg-white text-blue-600 font-bold text-xl rounded-lg hover:bg-blue-100 transition-colors"
        >
          Start Game
        </button>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen bg-black">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        style={{ display: 'block', width: '100vw', height: '100vh' }}
      />

      {/* HUD */}
      <div className="absolute top-4 left-4 bg-black bg-opacity-50 text-white p-4 rounded-lg">
        <div className="space-y-2">
          <div>Score: {gameStats.score}</div>
          <div>Distance: {Math.floor(gameStats.distance)}m</div>
          <div>Combo: x{gameStats.combo}</div>
          <div>Gravity: {gameStats.gravityState === 'down' ? '⬇️' : '⬆️'}</div>
          <div className="text-xs opacity-75">FPS: {gameRefs.current.fps}</div>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute bottom-4 left-4 bg-black bg-opacity-50 text-white p-2 rounded-lg text-sm">
        Click/Space: Flip Gravity | Arrows: Steer
      </div>

      {/* Gravity flip button for mobile */}
      <button
        onClick={flipGravity}
        className="absolute bottom-4 right-4 bg-white bg-opacity-80 text-blue-600 p-4 rounded-full font-bold text-lg hover:bg-opacity-100 transition-all"
      >
        Flip Gravity
      </button>
    </div>
  )
}